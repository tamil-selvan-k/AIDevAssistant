/**
 * Scenario C — Tier-2 demo: state-invariant bug
 * updateOrderStatus allows any OrderStatus → OrderStatus transition,
 * including illegal ones like refunded → shipped.
 * Both individual values are valid; the transition is the bug.
 */

type OrderStatus = 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';

/**
 * Updates the status of an order.
 * Valid transitions:
 *   pending → confirmed → shipped → delivered
 *   pending → cancelled
 *   delivered → refunded
 * Any other transition is invalid and must be rejected.
 */
function updateOrderStatus(currentStatus: OrderStatus, newStatus: OrderStatus): OrderStatus {
  // Bug: no transition validation — allows refunded → shipped, cancelled → delivered, etc.
  return newStatus;
}

export { updateOrderStatus, OrderStatus };
