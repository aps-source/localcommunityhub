/**
 * Sends a push notification to every device that hub's owner has enabled notifications on,
 * whenever a new order arrives at that hub or an existing one is edited/cancelled by the
 * customer. Device tokens are registered by the client under
 * /hubs/{hubId}/fcmTokens/{token} when that hub's owner taps "Enable notifications" in
 * Manage hub — this function only ever reads that list and sends to it, it never writes
 * order data. Each hub's tokens are scoped separately so one hub's staff never gets paged
 * for another hub's orders.
 */
const { onValueCreated, onValueUpdated } = require("firebase-functions/v2/database");
const admin = require("firebase-admin");
admin.initializeApp();

async function sendToHubDevices(hubId, title, body) {
  const tokensSnap = await admin.database().ref("hubs/" + hubId + "/fcmTokens").once("value");
  if (!tokensSnap.exists()) return;
  const tokens = Object.keys(tokensSnap.val());
  if (tokens.length === 0) return;

  const resp = await admin.messaging().sendEachForMulticast({
    notification: { title, body },
    data: { hubId },
    tokens,
  });

  // Drop tokens the browser itself has invalidated (uninstalled PWA, permission revoked,
  // cleared site data) so the list doesn't grow stale forever.
  const stale = [];
  resp.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error && r.error.code;
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
      ) {
        stale.push(tokens[i]);
      }
    }
  });
  if (stale.length) {
    const updates = {};
    stale.forEach((t) => {
      updates[t] = null;
    });
    await admin.database().ref("hubs/" + hubId + "/fcmTokens").update(updates);
  }
}

exports.notifyNewOrder = onValueCreated("/hubs/{hubId}/orders/{orderId}", async (event) => {
  const order = event.data.val();
  if (!order || order.status !== "PENDING") return;
  const itemsText = (order.items || []).map((i) => i.qty + "x " + i.name).join(", ");
  await sendToHubDevices(
    event.params.hubId,
    "New order — " + (order.tokenDisplay || ""),
    itemsText + (order.fulfilment === "DELIVERY" ? " · Delivery" : " · Pickup")
  );
});

exports.notifyOrderAction = onValueUpdated("/hubs/{hubId}/orders/{orderId}", async (event) => {
  const before = event.data.before.val() || {};
  const after = event.data.after.val() || {};
  if (!after.customerActionAt || after.customerActionAt === before.customerActionAt) return;

  const cancelled = after.customerActionType === "CANCELLED";
  const title = (cancelled ? "Order cancelled — " : "Order updated — ") + (after.tokenDisplay || "");
  const body = cancelled
    ? "Cancelled by the customer."
    : (after.items || []).map((i) => i.qty + "x " + i.name).join(", ");
  await sendToHubDevices(event.params.hubId, title, body);
});
