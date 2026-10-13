// Coordinates use a unit circle so dragging works at every rendered size.
export function launcherPointerAt(x, y) {
  const distance = Math.hypot(x, y);
  if (!Number.isFinite(distance)) return { x: 0, y: 0, sector: null };
  // Follow freely near the center, then resist like an elastic tether.
  const reach = distance <= 0.43 ? distance : 0.43 + 0.16 * (1 - Math.exp(-(distance - 0.43) * 2.4));
  const scale = distance ? reach / distance : 1;
  const angle = (Math.atan2(x, -y) + Math.PI / 4 + Math.PI * 2) % (Math.PI * 2);
  return {
    x: x * scale,
    y: y * scale,
    sector: distance < 0.36 || distance > 1.08 ? null : Math.floor(angle / (Math.PI / 2)),
  };
}

export function stepLauncherSpring(state, target, seconds, held = false) {
  const stiffness = held ? 540 : 180;
  const damping = held ? 38 : 16;
  const duration = Math.max(0, Math.min(0.064, seconds));
  const steps = Math.max(1, Math.ceil(duration / (1 / 120)));
  const dt = duration / steps;
  let { x, y, vx, vy } = state;
  for (let index = 0; index < steps; index += 1) {
    vx += ((target.x - x) * stiffness - vx * damping) * dt;
    vy += ((target.y - y) * stiffness - vy * damping) * dt;
    x += vx * dt;
    y += vy * dt;
  }
  const settled = Math.hypot(target.x - x, target.y - y) < 0.0005 && Math.hypot(vx, vy) < 0.002;
  return settled ? { x: target.x, y: target.y, vx: 0, vy: 0, settled } : { x, y, vx, vy, settled };
}
