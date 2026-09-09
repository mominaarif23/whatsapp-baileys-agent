/*
 * WhatsApp AI Agent (Baileys + Groq)
 * -------------------------------------
 * Connects directly to WhatsApp's protocol (no browser/Chrome needed,
 * unlike whatsapp-web.js). Whenever a new message arrives, it asks
 * Groq for a reply and sends it back.
 *
 * Setup:
 * 1. npm install
 * 2. Create a ".env" file in this folder with:
 *    GROQ_API_KEY=your_real_groq_key
 * 3. node index.js
 * 4. A QR code will appear - scan it with your phone
 *    (WhatsApp -> Settings -> Linked Devices -> Link a Device)
 * 5. Once you see "Connected to WhatsApp!", any incoming message
 *    will get an AI-generated reply.
 */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const Groq = require('groq-sdk');
const pino = require('pino');

const groqApiKey = process.env.GROQ_API_KEY;
if (!groqApiKey) {
    throw new Error('API key not found! Check your .env file.');
}
const groq = new Groq({ apiKey: groqApiKey });

// ---- Voice message transcription (Groq's Whisper model, no extra cost) ----
// Downloads the voice note, saves it briefly to a temp file, sends it to
// Groq for speech-to-text, then deletes the temp file.
async function transcribeVoiceMessage(msg) {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    const tempFilePath = path.join(os.tmpdir(), `voice-${Date.now()}.ogg`);
    fs.writeFileSync(tempFilePath, buffer);

    try {
        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(tempFilePath),
            model: 'whisper-large-v3'
            // No language pinned - let Whisper auto-detect whatever
            // language the customer actually spoke in
        });
        return transcription.text;
    } finally {
        fs.unlinkSync(tempFilePath); // clean up the temp file either way
    }
}

// ---- Safe JSON file reading ----
// If a file is missing, empty, or corrupted, this returns the given
// default instead of crashing the whole agent.
function readJsonSafe(filePath, defaultValue) {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
        return defaultValue;
    }
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return defaultValue; // empty file
    try {
        return JSON.parse(raw);
    } catch (err) {
        console.error(`Warning: ${filePath} was corrupted, resetting it. (${err.message})`);
        fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
        return defaultValue;
    }
}

// ---- Registered users storage ----
// New numbers register themselves (by giving their name) the first
// time they message. Saved to a file so it survives a restart.
const USERS_FILE = 'registered_users.json';

function loadRegisteredUsers() {
    return readJsonSafe(USERS_FILE, {});
}

function saveRegisteredUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

let registeredUsers = loadRegisteredUsers(); // { "<jid>": { name: "..." } }

// ---- Active deals storage ----
// Saved to a file so the discount is remembered even if the agent restarts.
const DEALS_FILE = 'active_deals.json';

function loadActiveDeals() {
    return readJsonSafe(DEALS_FILE, []);
}

function saveActiveDeals(deals) {
    fs.writeFileSync(DEALS_FILE, JSON.stringify(deals, null, 2));
}

let activeDeals = loadActiveDeals(); // [{ item, originalPrice, percent, discountedPrice }]

// ---- Remembers the last deal banner image, if one was attached ----
// so it can also be sent to existing customers who later ask about deals
const DEAL_BANNER_FILE = 'deal_banner.json';

function loadDealBannerPath() {
    const data = readJsonSafe(DEAL_BANNER_FILE, { path: null });
    return data.path || null;
}

function saveDealBannerPath(path) {
    fs.writeFileSync(DEAL_BANNER_FILE, JSON.stringify({ path }, null, 2));
}

let currentDealBannerPath = loadDealBannerPath();

// ---- Orders storage ----
// Confirmed orders are saved here so they can be viewed/managed on the
// local dashboard (mark as prepared/delivered).
const ORDERS_FILE = 'orders.json';

function loadOrders() {
    return readJsonSafe(ORDERS_FILE, []);
}

function saveOrders(orders) {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

function addOrder(order) {
    const orders = loadOrders();
    const nextOrderNumber =
        orders.length > 0 ? Math.max(...orders.map((o) => o.orderNumber || 1000)) + 1 : 1001;
    orders.push({
        id: Date.now().toString(),
        orderNumber: nextOrderNumber,
        status: 'pending', // pending -> preparing -> ready -> delivered
        createdAt: new Date().toISOString(),
        ...order
    });
    saveOrders(orders);
}

// Extracts the numeric value from a price string like "Rs. 450" -> 450
function parsePriceNumber(priceString) {
    const match = priceString.replace(/,/g, '').match(/\d+(\.\d+)?/);
    return match ? parseFloat(match[0]) : null;
}

function formatPrice(amount) {
    return `Rs. ${Math.round(amount)}`;
}

// ---- Small helper to ask questions in the terminal ----
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function askQuestion(query) {
    return new Promise((resolve) => rl.question(query, resolve));
}

// ---- Broadcast a deal message (with optional attachment) to every registered contact ----
async function sendDealToAllContacts(sock, dealMessage, attachmentPath = null) {
    const numbers = Object.keys(registeredUsers);

    if (numbers.length === 0) {
        console.log('No registered contacts yet - nothing to send.');
        return;
    }

    console.log(`Sending deal to ${numbers.length} contact(s)...`);
    for (const jid of numbers) {
        try {
            if (attachmentPath) {
                // Send the image/document with the deal text as its caption
                await sendAttachment(sock, jid, attachmentPath, dealMessage);
            } else {
                await sock.sendMessage(jid, { text: dealMessage });
            }

            // Also send the menu along with every deal, so customers can
            // immediately see what else is available
            if (fs.existsSync(MENU_FILE_PATH)) {
                await sendAttachment(sock, jid, MENU_FILE_PATH, 'Here is our full menu!');
            }

            console.log(`Sent to ${registeredUsers[jid].name || jid}`);
        } catch (err) {
            console.error(`Failed to send to ${jid}:`, err);
        }
        // Small delay between messages to avoid sending too fast
        await new Promise((r) => setTimeout(r, 1000));
    }
    console.log('Deal broadcast finished.');
}

// Numbers that have been asked for their name but haven't replied yet
// (this doesn't need to survive a restart, so a simple Set is enough)
const awaitingName = new Set();

// ---- Conversation memory ----
// Keeps recent messages per user so the AI has context of what was
// discussed earlier. This resets if the agent restarts (it's not
// saved to a file) - only the last MAX_HISTORY messages are kept per
// user, to avoid sending huge amounts of text (and cost) on every call.
const conversationHistory = new Map(); // "<jid>" -> [{ role, content }, ...]
const MAX_HISTORY = 10;

function getHistory(jid) {
    if (!conversationHistory.has(jid)) conversationHistory.set(jid, []);
    return conversationHistory.get(jid);
}

function addToHistory(jid, role, content) {
    const history = getHistory(jid);
    history.push({ role, content });
    // Keep only the most recent MAX_HISTORY messages
    while (history.length > MAX_HISTORY) history.shift();
}

// ---- Basic rate limiting (per user) ----
// Prevents one person from spamming the bot too fast, which protects
// against runaway API costs and reduces the chance of WhatsApp
// flagging the number for bot-like/automated behavior.
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_MESSAGES = 6; // max messages allowed per window
const messageTimestamps = new Map(); // "<jid>" -> [timestamp, timestamp, ...]

function isRateLimited(jid) {
    const now = Date.now();
    const timestamps = (messageTimestamps.get(jid) || []).filter(
        (t) => now - t < RATE_LIMIT_WINDOW_MS
    );
    timestamps.push(now);
    messageTimestamps.set(jid, timestamps);
    return timestamps.length > RATE_LIMIT_MAX_MESSAGES;
}

// A random short delay before replying, so replies don't feel like an
// instant bot firing back within milliseconds - looks more natural
// and lowers the chance of automated behavior being flagged.
function randomDelay(minMs = 1000, maxMs = 3000) {
    const ms = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Caps how long an incoming message can be, to avoid huge/expensive
// API calls from unusually long or spammy messages
const MAX_MESSAGE_LENGTH = 500;

// ---- Attachments ----
// Put files here (e.g. a menu image or PDF) and they can be sent
// automatically. Place the actual file in this folder with this name.
const MENU_FILE_PATH = './assets/menu.jpg'; // change to menu.pdf if using a PDF

// Sends an image or document from disk, based on its file extension.
// Does nothing (just logs) if the file doesn't exist, so this never
// crashes the agent if you haven't added a menu file yet.
async function sendAttachment(sock, jid, filePath, caption = '') {
    if (!fs.existsSync(filePath)) {
        console.log(`Attachment not found at ${filePath} - skipping.`);
        return;
    }

    const buffer = fs.readFileSync(filePath);
    const ext = filePath.split('.').pop().toLowerCase();

    if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
        await sock.sendMessage(jid, { image: buffer, caption });
    } else if (ext === 'pdf') {
        await sock.sendMessage(jid, {
            document: buffer,
            mimetype: 'application/pdf',
            fileName: filePath.split('/').pop(),
            caption
        });
    } else {
        console.log(`Unsupported attachment type: ${ext}`);
    }
}

// ---- Business profile ----
// This is where all the business-specific information lives. Keeping
// it separate from the logic below means updating the menu, hours,
// or tone doesn't require touching any of the WhatsApp/AI code.
const BUSINESS = {
    name: 'Lahore Bites',
    type: 'Restaurant (Pakistani & fast food)',
    hours: 'Every day, 12:00 PM - 12:00 AM',
    deliveryAreas: 'Gulberg, Model Town, DHA, Johar Town (Lahore only)',
    deliveryFee: 'Rs. 100 flat, free above Rs. 1500',
    paymentMethods: 'Cash on delivery, EasyPaisa, JazzCash',
    menu: [
        { item: 'Chicken Karahi (Full)', price: 'Rs. 1400' },
        { item: 'Chicken Karahi (Half)', price: 'Rs. 800' },
        { item: 'Beef Biryani (Plate)', price: 'Rs. 350' },
        { item: 'Zinger Burger', price: 'Rs. 450' },
        { item: 'Loaded Fries', price: 'Rs. 400' },
        { item: 'Chicken Shawarma', price: 'Rs. 300' },
        { item: 'Soft Drink (500ml)', price: 'Rs. 100' }
    ]
};

function buildMenuTable() {
    const nameWidth = Math.max(...BUSINESS.menu.map((m) => m.item.length)) + 3;
    const rows = BUSINESS.menu.map((m) => `${m.item.padEnd(nameWidth)}${m.price}`);
    // Triple backticks make WhatsApp render this as a monospaced block,
    // which keeps the columns aligned like a simple table.
    return '```\n' + rows.join('\n') + '\n```';
}

function buildDealsText() {
    if (activeDeals.length === 0) return 'No active deals right now.';
    return activeDeals
        .map(
            (d) =>
                `- ${d.item}: ${d.percent}% OFF -> was ${formatPrice(d.originalPrice)}, now ${formatPrice(d.discountedPrice)}`
        )
        .join('\n');
}

function buildSystemPrompt(userName) {
    const menuText = buildMenuTable();
    const dealsText = buildDealsText();

    return `You are the WhatsApp assistant for "${BUSINESS.name}", a ${BUSINESS.type}.
You are chatting with a customer named ${userName}.

BUSINESS INFO:
- Operating hours: ${BUSINESS.hours}
- Delivery areas: ${BUSINESS.deliveryAreas}
- Delivery fee: ${BUSINESS.deliveryFee}
- Payment methods: ${BUSINESS.paymentMethods}

MENU (regular prices - when listing the full menu, paste this exact block as-is so it stays aligned, don't reformat it into a different list style):
${menuText}

ACTIVE DEALS (use these prices instead of the regular price for these items):
${dealsText}

YOUR ROLE:
- Reply in the same language the customer used. If they wrote or spoke in Urdu (Roman Urdu or Urdu script), reply in Roman Urdu (Urdu written in English/Latin letters). If they wrote in English, reply in English.
- All prices are in Pakistani Rupees (PKR). Always write prices with "Rs." prefix (e.g. "Rs. 450") - never use $ or any other currency symbol.
- Answer questions about the menu, prices, hours, delivery, and payment using ONLY the info above.
- If an item has an active deal, always quote the discounted price, and mention the discount percentage.
- If something is not on the menu or outside delivery areas, politely say so - do not make up items, prices, or areas that aren't listed.
- Keep replies short, warm, and professional, like a real restaurant's WhatsApp support.
- If a question is unrelated to the restaurant (e.g. general knowledge), politely redirect back to how you can help with their order.

ORDER-TAKING PROCEDURE (follow these steps in order, don't skip any):
1. When a customer wants to order, first make sure you know exactly which items and quantities they want. Ask if anything is unclear.
2. If you don't have their delivery address yet, you MUST ask for it before going further. Never assume or skip this.
3. Once you have items, quantities, AND address, calculate and show an order summary: each item with its price, the delivery fee (${BUSINESS.deliveryFee}), and the final total. Then explicitly ask the customer to confirm (e.g. "Shall I confirm this order?").
4. Only after the customer clearly confirms (e.g. "yes", "haan", "confirm karo") should you call the confirm_order tool - include the delivery fee in the total you pass to it. Never call the tool before step 3's confirmation question has been asked and answered.

CRITICAL: Never call confirm_order if you don't already know all of: items, address, AND total. If any of these is missing or unclear, respond with a normal text message asking for the missing information instead of calling the tool. Calling the tool with guessed, empty, or incomplete information is a serious error.`;
}

// ---- Tool definition: lets the AI signal a confirmed order to our code ----
const ORDER_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'confirm_order',
            description:
                'Call this ONLY after you have asked the customer to confirm their order summary (items, delivery fee, total) and they have explicitly said yes/confirmed. Never call this before that confirmation step.',
            parameters: {
                type: 'object',
                properties: {
                    items: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Ordered items with quantities, e.g. ["2x Zinger Burger", "1x Loaded Fries"]'
                    },
                    address: {
                        type: 'string',
                        description: "Customer's delivery address"
                    },
                    total: {
                        type: 'string',
                        description: 'Final total including the delivery fee, as a string, e.g. "Rs. 1000"'
                    }
                },
                required: ['items', 'address', 'total']
            }
        }
    }
];

// Ask the AI model for a reply, including recent conversation history
// so it remembers what was discussed earlier in the chat
async function getAiReply(jid, userMessage, userName) {
    const history = getHistory(jid);
    const baseMessages = [
        { role: 'system', content: buildSystemPrompt(userName) },
        ...history,
        { role: 'user', content: userMessage }
    ];

    let response;
    try {
        response = await groq.chat.completions.create({
            model: 'openai/gpt-oss-20b',
            max_tokens: 300,
            tools: ORDER_TOOLS,
            tool_choice: 'auto',
            messages: baseMessages
        });
    } catch (err) {
        // If the model tried an invalid/incomplete tool call, Groq rejects
        // the whole request. Fall back to a plain reply (no tools) so the
        // customer still gets a normal response instead of silence.
        console.error('Tool-enabled call failed, retrying without tools:', err.message || err);
        response = await groq.chat.completions.create({
            model: 'openai/gpt-oss-20b',
            max_tokens: 300,
            messages: baseMessages
        });
    }

    const responseMessage = response.choices[0].message;

    // ---- If the AI decided the order is confirmed, validate before saving ----
    const toolCalls = responseMessage.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
        for (const call of toolCalls) {
            if (call.function.name === 'confirm_order') {
                try {
                    const orderDetails = JSON.parse(call.function.arguments);

                    // Reject fake/placeholder data (empty items, blank
                    // address, zero/empty total) instead of trusting it
                    const hasItems = Array.isArray(orderDetails.items) && orderDetails.items.length > 0;
                    const hasAddress = orderDetails.address && orderDetails.address.trim().length > 3;
                    const hasTotal =
                        orderDetails.total &&
                        parsePriceNumber(orderDetails.total) &&
                        parsePriceNumber(orderDetails.total) > 0;

                    if (!hasItems || !hasAddress || !hasTotal) {
                        console.log(
                            `Rejected an incomplete/invalid order attempt for '${userName}' - asking for missing info instead.`
                        );
                        const followUp =
                            'Could you please confirm the item(s), quantity, and your full delivery address so I can complete your order?';
                        addToHistory(jid, 'user', userMessage);
                        addToHistory(jid, 'assistant', followUp);
                        return followUp;
                    }

                    addOrder({
                        jid,
                        customerName: userName,
                        items: orderDetails.items,
                        address: orderDetails.address,
                        total: orderDetails.total
                    });
                    console.log(`Order saved for '${userName}' (${jid}).`);
                } catch (err) {
                    console.error('Failed to parse/save order:', err);
                }
            }
        }

        // Build a direct confirmation reply ourselves (more reliable than
        // asking the model for a second round-trip)
        const reply = `Your order has been confirmed! We'll get started on it right away. Thank you for ordering from ${BUSINESS.name}!`;
        addToHistory(jid, 'user', userMessage);
        addToHistory(jid, 'assistant', reply);
        return reply;
    }

    const reply = response.choices[0].message.content;

    // Save both sides of this exchange to memory for next time
    addToHistory(jid, 'user', userMessage);
    addToHistory(jid, 'assistant', reply);

    return reply;
}

async function showStartupMenu(sock) {
    console.log('\nWhat would you like to do?');
    console.log('1) Customer Service - auto-reply to incoming messages');
    console.log('2) Send Deal - apply a discount and broadcast it to all registered contacts');

    const choice = await askQuestion('Choose an option (1 or 2): ');

    if (choice.trim() === '2') {
        console.log('\nMenu items:');
        const nameWidth = Math.max(...BUSINESS.menu.map((m) => m.item.length)) + 3;
        BUSINESS.menu.forEach((m, i) =>
            console.log(`${(i + 1 + ')').padEnd(4)}${m.item.padEnd(nameWidth)}${m.price}`)
        );

        const itemChoice = await askQuestion('Which item number is on deal? ');
        const menuItem = BUSINESS.menu[parseInt(itemChoice.trim(), 10) - 1];

        if (!menuItem) {
            console.log('Invalid item number - cancelling.');
            return;
        }

        const percentInput = await askQuestion(`Discount percentage for "${menuItem.item}"? (e.g. 20): `);
        const percent = parseFloat(percentInput.trim());

        if (isNaN(percent) || percent <= 0 || percent >= 100) {
            console.log('Invalid percentage - cancelling.');
            return;
        }

        const originalPrice = parsePriceNumber(menuItem.price);
        const discountedPrice = originalPrice * (1 - percent / 100);

        // Save (or update) this deal so future AI replies know about it too
        activeDeals = activeDeals.filter((d) => d.item !== menuItem.item);
        activeDeals.push({
            item: menuItem.item,
            originalPrice,
            percent,
            discountedPrice
        });
        saveActiveDeals(activeDeals);

        const dealMessage =
            `🔥 Deal Alert from ${BUSINESS.name}! 🔥\n` +
            `${percent}% OFF on ${menuItem.item}!\n` +
            `Now just ${formatPrice(discountedPrice)} (was ${formatPrice(originalPrice)})\n` +
            `Order now before it ends!`;

        console.log('\nGenerated deal message:\n' + dealMessage + '\n');

        const attachChoice = await askQuestion('Attach an image with this deal? (y/n): ');
        let attachmentPath = null;
        if (attachChoice.trim().toLowerCase() === 'y') {
            attachmentPath = (await askQuestion('Path to the image file (e.g. ./assets/deal-banner.jpg): ')).trim();
            currentDealBannerPath = attachmentPath;
            saveDealBannerPath(attachmentPath);
        }

        await sendDealToAllContacts(sock, dealMessage, attachmentPath);
        console.log('\nDeal sent and saved. The AI will now quote this discounted price too.');
        console.log('Customer Service auto-reply is active in the background.');
    } else {
        console.log('\nCustomer Service mode active. Waiting for new messages...');
    }
}

// ---- Local restaurant management dashboard ----
// A browser-based dashboard (http://localhost:3000) with role-based
// sections: Admin (full access), Chef (kitchen orders only), and
// Waiter (orders + tables). Views live in /views (EJS templates),
// styles in /public/css/style.css, client-side scripts in /public/js.
// Customers continue to interact via WhatsApp - a web ordering portal
// for customers is a separate, larger feature that can be added later.
const express = require('express');
const session = require('express-session');
const path2 = require('path'); // aliased to avoid clashing with the 'path' import above

const USERS = {
    [process.env.ADMIN_USERNAME || 'admin']: {
        password: process.env.ADMIN_PASSWORD || 'change_this_password',
        role: 'admin'
    },
    [process.env.CHEF_USERNAME || 'chef']: {
        password: process.env.CHEF_PASSWORD || 'change_this_password_too',
        role: 'chef'
    },
    [process.env.WAITER_USERNAME || 'waiter']: {
        password: process.env.WAITER_PASSWORD || 'change_this_password_too',
        role: 'waiter'
    }
};

// Which sidebar sections each role can see, and which URL they open
const NAV_BY_ROLE = {
    admin: [
        { label: 'Orders', href: '/orders-page' },
        { label: 'Menu', href: '/menu-page' },
        { label: 'Tables', href: '/tables-page' },
        { label: 'Inventory', href: '/inventory-page' },
        { label: 'Reports', href: '/reports-page' },
        { label: 'Users', href: '/users-page' }
    ],
    chef: [{ label: 'Kitchen Orders', href: '/kitchen-page' }],
    waiter: [
        { label: 'Orders', href: '/orders-page' },
        { label: 'Tables', href: '/tables-page' }
    ]
};

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    return res.redirect('/login');
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (req.session && req.session.user && roles.includes(req.session.user.role)) {
            return next();
        }
        return res.status(403).send('Access denied - your role does not have permission to view this page.');
    };
}

const LANDING_PAGE_BY_ROLE = { admin: '/orders-page', chef: '/kitchen-page', waiter: '/orders-page' };

function startOrdersDashboard() {
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path2.join(__dirname, 'views'));
    app.use(express.static(path2.join(__dirname, 'public')));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    
    app.set('trust proxy', 1);

    app.use(
        session({
            secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
            resave: false,
            saveUninitialized: false,
            cookie: { 
                maxAge: 8 * 60 * 60 * 1000,
                sameSite: 'lax'
            }
        })
    );

    // ---- Login ----
    app.get('/login', (req, res) => {
        res.render('login', { businessName: BUSINESS.name, error: !!req.query.error });
    });

    app.post('/login', (req, res) => {
        const { username, password } = req.body;
        const user = USERS[username];
        if (user && user.password === password) {
            req.session.user = { username, role: user.role };
            return res.redirect(LANDING_PAGE_BY_ROLE[user.role] || '/login');
        }
        res.redirect('/login?error=1');
    });

    app.post('/logout', (req, res) => {
        req.session.destroy(() => res.redirect('/login'));
    });

    app.get('/', requireAuth, (req, res) => {
        res.redirect(LANDING_PAGE_BY_ROLE[req.session.user.role] || '/login');
    });

    // ---- Data API routes ----
    app.get('/api/orders', requireAuth, (req, res) => res.json(loadOrders()));
    app.get('/me', requireAuth, (req, res) => res.json(req.session.user));

    app.post('/api/orders/:id/status', requireAuth, requireRole('admin', 'chef', 'waiter'), (req, res) => {
        const orders = loadOrders();
        const order = orders.find((o) => o.id === req.params.id);
        if (!order) return res.status(404).json({ error: 'Order not found' });
        order.status = req.body.status;
        saveOrders(orders);
        res.json(order);
    });

    app.delete('/api/orders/:id', requireAuth, requireRole('admin'), (req, res) => {
        const orders = loadOrders().filter((o) => o.id !== req.params.id);
        saveOrders(orders);
        res.json({ deleted: true });
    });

    // ---- Orders page (Admin, Waiter) ----
    app.get('/orders-page', requireAuth, requireRole('admin', 'waiter'), (req, res) => {
        res.render('orders', {
            businessName: BUSINESS.name,
            user: req.session.user,
            navItems: NAV_BY_ROLE[req.session.user.role],
            activeHref: '/orders-page',
            title: 'Orders',
            subtitle: 'All customer orders, from placed to delivered.',
            paymentMethods: BUSINESS.paymentMethods
        });
    });

    // ---- Kitchen Orders page (Chef) ----
    app.get('/kitchen-page', requireAuth, requireRole('chef', 'admin'), (req, res) => {
        res.render('kitchen', {
            businessName: BUSINESS.name,
            user: req.session.user,
            navItems: NAV_BY_ROLE[req.session.user.role],
            activeHref: '/kitchen-page',
            title: 'Kitchen Orders',
            subtitle: 'Orders that need to be accepted and prepared.'
        });
    });

    // ---- Placeholder pages (structure ready, functionality to be built later) ----
    const placeholders = [
        { href: '/menu-page', title: 'Menu Management', roles: ['admin'] },
        { href: '/tables-page', title: 'Tables', roles: ['admin', 'waiter'] },
        { href: '/inventory-page', title: 'Inventory', roles: ['admin'] },
        { href: '/reports-page', title: 'Reports', roles: ['admin'] },
        { href: '/users-page', title: 'Users', roles: ['admin'] }
    ];
    placeholders.forEach(({ href, title, roles }) => {
        app.get(href, requireAuth, requireRole(...roles), (req, res) => {
            res.render('coming-soon', {
                businessName: BUSINESS.name,
                user: req.session.user,
                navItems: NAV_BY_ROLE[req.session.user.role],
                activeHref: href,
                title,
                subtitle: 'This section is planned but not built yet.'
            });
        });
    });

    const PORT = 3000;
    app.listen(PORT, () => {
        console.log(`Dashboard running at http://localhost:${PORT}`);
    });
}

async function startBot() {
    // Session info is saved here, so you won't need to scan the QR
    // code again after the first successful login
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }) // keep the console clean
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR code below - scan it with your phone:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('Connected to WhatsApp!');
            await showStartupMenu(sock);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];
        // Ignore messages sent by us, and messages with no text body
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        let text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            '';

        // If it's a voice note, transcribe it first so it flows through
        // the exact same logic as a normal text message
        if (!text && msg.message.audioMessage) {
            try {
                console.log(`Voice message from '${from}' - transcribing...`);
                text = await transcribeVoiceMessage(msg);
                console.log(`Transcribed: ${text}`);
            } catch (err) {
                console.error('Voice transcription failed:', err);
                return;
            }
        }

        if (!text) return;

        console.log(`New message from '${from}': ${text}`);

        // ---- Security check 1: message length cap ----
        // Protects against unusually long messages driving up API costs
        const safeText = text.slice(0, MAX_MESSAGE_LENGTH);

        // ---- Security check 2: rate limiting ----
        // If someone sends too many messages too quickly, briefly stop
        // replying to them instead of burning API calls / looking bot-like
        if (isRateLimited(from)) {
            console.log(`'${from}' is sending messages too fast - rate limited, skipping.`);
            return;
        }

        try {
            // ---- Step 1: already registered? Reply normally with AI ----
            if (registeredUsers[from]) {
                const userName = registeredUsers[from].name;
                const aiReply = await getAiReply(from, safeText, userName);
                await randomDelay(); // slight human-like pause before replying
                await sock.sendMessage(from, { text: aiReply });
                console.log('Replied with AI response.');

                // If they asked about the menu, also send the menu attachment
                const lowerText = safeText.toLowerCase();
                if (lowerText.includes('menu')) {
                    const menuCaption =
                        activeDeals.length > 0
                            ? `Here is our menu! Current deals:\n${buildDealsText()}`
                            : 'Here is our menu!';
                    await sendAttachment(sock, from, MENU_FILE_PATH, menuCaption);
                }
                // If they asked about a deal/discount/offer, send the deal banner too
                if (
                    currentDealBannerPath &&
                    (lowerText.includes('deal') ||
                        lowerText.includes('discount') ||
                        lowerText.includes('offer'))
                ) {
                    await sendAttachment(sock, from, currentDealBannerPath, '');
                }
                return;
            }

            // ---- Step 2: we already asked for their name, this message IS the name ----
            if (awaitingName.has(from)) {
                const name = safeText.trim().slice(0, 50); // cap name length too
                registeredUsers[from] = { name };
                saveRegisteredUsers(registeredUsers);
                awaitingName.delete(from);

                await randomDelay();
                await sock.sendMessage(from, {
                    text: `Thanks, ${name}! Welcome to ${BUSINESS.name}. You can now ask about our menu, prices, hours, or place an order.`
                });

                // Show the menu, and mention any active deals right in the caption
                const menuCaption =
                    activeDeals.length > 0
                        ? `Here is our menu! Current deals:\n${buildDealsText()}`
                        : 'Here is our menu!';
                await sendAttachment(sock, from, MENU_FILE_PATH, menuCaption);
                console.log(`'${from}' registered as '${name}'.`);
                return;
            }

            // ---- Step 3: brand new number, ask them to register first ----
            awaitingName.add(from);
            await randomDelay();
            await sock.sendMessage(from, {
                text: `Welcome to ${BUSINESS.name}! Please reply with your name to get started.`
            });
            console.log(`Asked '${from}' to register.`);
        } catch (err) {
            console.error('Error handling message:', err);
        }
    });
}

startOrdersDashboard();
startBot();