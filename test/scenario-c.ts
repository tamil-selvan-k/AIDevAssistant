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
  // Define valid transitions
  const validTransitions: Record<OrderStatus, OrderStatus[]> = {
    'pending': ['confirmed', 'cancelled'],
    'confirmed': ['shipped', 'cancelled'],
    'shipped': ['delivered', 'cancelled'],
    'delivered': ['refunded'],
    'cancelled': [],
    'refunded': [],
  };  

  if (!validTransitions[currentStatus].includes(newStatus)) {
    throw new Error(`Invalid transition: ${currentStatus} → ${newStatus}`);
  }
  return newStatus;
}

export { updateOrderStatus, OrderStatus };
