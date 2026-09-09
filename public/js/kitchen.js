// Kitchen Orders page client-side logic (Chef view)
function statusLabel(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

async function loadOrders() {
    const res = await fetch('/api/orders');
    const orders = (await res.json()).filter((o) => o.status === 'pending' || o.status === 'preparing');
    const container = document.getElementById('orders');
    if (orders.length === 0) {
        container.innerHTML = '<div class="empty">No orders to prepare. 🎉</div>';
        return;
    }
    container.innerHTML = orders
        .slice()
        .reverse()
        .map(
            (o) => `
    <div class="order">
      <div class="order-top"><div class="customer-name">#${o.orderNumber || o.id.slice(-4)} - ${o.customerName || 'Customer'}</div><div class="status ${o.status}">${statusLabel(o.status)}</div></div>
      <div class="items">${(o.items || []).join(', ')}</div>
      <div class="actions">
        ${
            o.status === 'pending'
                ? `<button class="btn-accept" onclick="setStatus('${o.id}','preparing')">Accept Order</button>`
                : `<button class="btn-ready" onclick="setStatus('${o.id}','ready')">Mark Ready</button>`
        }
      </div>
    </div>`
        )
        .join('');
}

async function setStatus(id, status) {
    await fetch('/api/orders/' + id + '/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
    });
    loadOrders();
}

loadOrders();
setInterval(loadOrders, 5000);