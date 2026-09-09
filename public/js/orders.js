// Orders page client-side logic (table view, card view, search, filters, modal)
let allOrders = [];
let currentView = 'table';
let currentFilter = 'all';

function statusLabel(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function actionButtonHtml(o) {
    if (o.status === 'pending') return `<button class="btn-accept" onclick="setStatus('${o.id}','preparing')">Accept Order</button>`;
    if (o.status === 'preparing') return `<button class="btn-ready" onclick="setStatus('${o.id}','ready')">Mark Ready</button>`;
    if (o.status === 'ready') return `<button class="btn-delivered" onclick="setStatus('${o.id}','delivered')">Mark Delivered</button>`;
    return ''; // delivered: no status action button - the "View Details" button below covers it
}

async function loadOrders() {
    const res = await fetch('/api/orders');
    allOrders = await res.json();
    render();
}

function render() {
    const total = allOrders.length;
    const pending = allOrders.filter((o) => o.status === 'pending').length;
    const delivered = allOrders.filter((o) => o.status === 'delivered').length;
    document.getElementById('stats').innerHTML = `
    <div class="stat-card"><div class="num">${total}</div><div class="label">Total Orders</div></div>
    <div class="stat-card"><div class="num">${pending}</div><div class="label">Pending</div></div>
    <div class="stat-card"><div class="num">${delivered}</div><div class="label">Delivered</div></div>`;

    const q = document.getElementById('searchBox').value.trim().toLowerCase();
    let filtered = allOrders.slice().reverse();
    if (currentFilter !== 'all') filtered = filtered.filter((o) => o.status === currentFilter);
    if (q) {
        filtered = filtered.filter(
            (o) =>
                String(o.orderNumber || '').includes(q) ||
                (o.customerName || '').toLowerCase().includes(q) ||
                (o.address || '').toLowerCase().includes(q)
        );
    }

    if (filtered.length === 0) {
        document.getElementById('tableBody').innerHTML = '<tr><td colspan="7"><div class="empty">No orders match.</div></td></tr>';
        document.getElementById('cardViewWrap').innerHTML = '<div class="empty">No orders match.</div>';
        return;
    }

    document.getElementById('tableBody').innerHTML = filtered
        .map(
            (o) => `
    <tr>
      <td>#${o.orderNumber || o.id.slice(-4)}</td>
      <td>${o.customerName || 'Customer'}</td>
      <td>${(o.items || []).join(', ')}</td>
      <td>${o.address || 'N/A'}</td>
      <td>${o.total || 'N/A'}</td>
      <td><span class="status ${o.status}">${statusLabel(o.status)}</span></td>
      <td>${actionButtonHtml(o)} <button class="btn-link" onclick="openDetails('${o.id}')">View Details</button></td>
    </tr>`
        )
        .join('');

    document.getElementById('cardViewWrap').innerHTML = filtered
        .map(
            (o) => `
    <div class="order ${o.status === 'delivered' ? 'delivered' : ''}">
      <div class="order-top"><div class="customer-name">#${o.orderNumber || o.id.slice(-4)} - ${o.customerName || 'Customer'}</div><div class="status ${o.status}">${statusLabel(o.status)}</div></div>
      <div class="items">${(o.items || []).join(', ')}</div>
      <div class="address">📍 ${o.address || 'N/A'}</div>
      <div class="total">💰 ${o.total || 'N/A'}</div>
      <div class="actions">${actionButtonHtml(o)} <button class="btn-link" onclick="openDetails('${o.id}')">View Details</button></div>
    </div>`
        )
        .join('');
}

function switchView(view) {
    currentView = view;
    document.getElementById('tableViewBtn').classList.toggle('active', view === 'table');
    document.getElementById('cardViewBtn').classList.toggle('active', view === 'card');
    document.getElementById('tableViewWrap').style.display = view === 'table' ? 'block' : 'none';
    document.getElementById('cardViewWrap').style.display = view === 'card' ? 'grid' : 'none';
}

function setFilter(f) {
    currentFilter = f;
    document.querySelectorAll('.filter-pill').forEach((p) => p.classList.toggle('active', p.dataset.filter === f));
    render();
}

async function setStatus(id, status) {
    await fetch('/api/orders/' + id + '/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
    });
    loadOrders();
}

function openDetails(id) {
    const o = allOrders.find((x) => x.id === id);
    if (!o) return;
    const modal = document.getElementById('detailsModal');
    document.getElementById('detailsModalContent').innerHTML = `
    <h3>Order #${o.orderNumber || o.id.slice(-4)}</h3>
    <div class="modal-row"><div class="label">Customer</div>${o.customerName || 'Customer'}</div>
    <div class="modal-row"><div class="label">Items</div>${(o.items || []).join(', ')}</div>
    <div class="modal-row"><div class="label">Table / Address</div>${o.address || 'N/A'}</div>
    <div class="modal-row"><div class="label">Order Time</div>${new Date(o.createdAt).toLocaleString()}</div>
    <div class="modal-row"><div class="label">Payment Method</div>${o.paymentMethod || window.PAYMENT_METHODS}</div>
    <div class="modal-row"><div class="label">Total</div>${o.total || 'N/A'}</div>
    <div class="modal-row"><div class="label">Status</div><span class="status ${o.status}">${statusLabel(o.status)}</span></div>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeDetails()">Close</button>
      ${window.IS_ADMIN ? `<button class="btn-delete-link" onclick="confirmDelete('${o.id}')">Delete Order</button>` : ''}
    </div>`;
    modal.classList.add('open');
}

function closeDetails() {
    document.getElementById('detailsModal').classList.remove('open');
}

function confirmDelete(id) {
    document.getElementById('detailsModalContent').innerHTML = `
    <div class="confirm-box">
      <h3>Delete this order?</h3>
      <p>This action cannot be undone.</p>
      <div class="confirm-actions">
        <button class="btn-cancel" onclick="closeDetails()">Cancel</button>
        <button class="btn-remove" onclick="removeOrder('${id}')">Delete</button>
      </div>
    </div>`;
}

async function removeOrder(id) {
    await fetch('/api/orders/' + id, { method: 'DELETE' });
    closeDetails();
    loadOrders();
}

loadOrders();
setInterval(loadOrders, 5000);