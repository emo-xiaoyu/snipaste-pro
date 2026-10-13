import { useEffect, useRef, useState } from 'react';
import { History20Regular, Image20Regular, Pin20Filled, TextDescription20Regular } from '@fluentui/react-icons';
import { launcherPointerAt, stepLauncherSpring } from './launcher-pointer.js';

const OPTIONS = [
  { name: '文字内容', description: '剪贴板文字', side: 'top', Icon: TextDescription20Regular },
  { name: '历史截图', description: '浏览与固定', side: 'right', Icon: History20Regular },
  { name: '图片记录', description: '剪贴板图片', side: 'bottom', Icon: Image20Regular },
  { name: '常用内容', description: '已固定项目', side: 'left', Icon: Pin20Filled },
];

export function LauncherWheel({ selection, onSelectionChange, onOpen, optionRefs, controlsRef }) {
  const wheelRef = useRef(null);
  const pointerRef = useRef(null);
  const lineRef = useRef(null);
  const arrowRef = useRef(null);
  const dragRef = useRef(null);
  const openedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const callbacksRef = useRef(null);
  const springRef = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const targetRef = useRef({ x: 0, y: 0 });
  const frameRef = useRef(0);
  const timeRef = useRef(0);
  const radiusRef = useRef(240);
  const reducedMotionRef = useRef(false);
  const localControlsRef = useRef(null);
  const [armed, setArmed] = useState(null);
  const [dragging, setDragging] = useState(false);
  callbacksRef.current = { selection, onSelectionChange, onOpen };

  function paint(point) {
    pointerRef.current?.style.setProperty('--pointer-x', `${point.x * radiusRef.current}px`);
    pointerRef.current?.style.setProperty('--pointer-y', `${point.y * radiusRef.current}px`);
    lineRef.current?.setAttribute('x2', String(50 + point.x * 50));
    lineRef.current?.setAttribute('y2', String(50 + point.y * 50));
    const angle = Math.hypot(point.x, point.y) > 0.015
      ? Math.atan2(point.x, -point.y) * 180 / Math.PI
      : callbacksRef.current.selection * 90;
    if (arrowRef.current) arrowRef.current.style.transform = `rotate(${angle}deg)`;
  }

  function animate(time) {
    frameRef.current = 0;
    const seconds = timeRef.current ? (time - timeRef.current) / 1000 : 1 / 60;
    timeRef.current = time;
    const next = stepLauncherSpring(springRef.current, targetRef.current, seconds, Boolean(dragRef.current));
    springRef.current = next;
    paint(next);
    if (!next.settled) frameRef.current = requestAnimationFrame(animate);
    else timeRef.current = 0;
  }

  function pull(next) {
    targetRef.current = { x: next.x, y: next.y };
    if (reducedMotionRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      timeRef.current = 0;
      springRef.current = { ...targetRef.current, vx: 0, vy: 0 };
      paint(springRef.current);
    } else if (!frameRef.current) {
      timeRef.current = 0;
      frameRef.current = requestAnimationFrame(animate);
    }
  }

  function cancel() {
    if (dragRef.current) suppressClickRef.current = true;
    dragRef.current = null;
    openedRef.current = false;
    setDragging(false);
    setArmed(null);
    pull({ x: 0, y: 0 });
  }

  function activate(index) {
    if (openedRef.current) return;
    openedRef.current = true;
    callbacksRef.current.onOpen(index);
  }

  localControlsRef.current = { cancel };
  controlsRef.current = localControlsRef.current;
  useEffect(() => {
    controlsRef.current = localControlsRef.current;
    const blur = () => cancel();
    const visibility = () => { if (document.hidden) cancel(); };
    const resize = () => {
      radiusRef.current = wheelRef.current.getBoundingClientRect().width / 2;
      paint(springRef.current);
    };
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const updateMotion = () => { reducedMotionRef.current = Boolean(motion?.matches); };
    updateMotion();
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(wheelRef.current);
    motion?.addEventListener('change', updateMotion);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      cancelAnimationFrame(frameRef.current);
      if (controlsRef.current === localControlsRef.current) controlsRef.current = null;
      observer?.disconnect();
      motion?.removeEventListener('change', updateMotion);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [controlsRef]);

  useEffect(() => { paint(springRef.current); }, [selection]);

  function move(event) {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return null;
    const rect = drag.rect;
    const result = launcherPointerAt(
      (event.clientX - rect.left - rect.width / 2) / (rect.width / 2) - drag.offsetX,
      (event.clientY - rect.top - rect.height / 2) / (rect.height / 2) - drag.offsetY,
    );
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true;
    pull(result);
    setArmed(result.sector);
    if (result.sector !== null) callbacksRef.current.onSelectionChange(result.sector);
    return result;
  }

  function begin(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    openedRef.current = false;
    // Ignore the synthetic click after pointer-up, even for a canceled drag.
    suppressClickRef.current = true;
    const rect = wheelRef.current.getBoundingClientRect();
    radiusRef.current = rect.width / 2;
    dragRef.current = {
      id: event.pointerId, rect, startX: event.clientX, startY: event.clientY, moved: false,
      offsetX: (event.clientX - rect.left - rect.width / 2) / (rect.width / 2) - springRef.current.x,
      offsetY: (event.clientY - rect.top - rect.height / 2) / (rect.height / 2) - springRef.current.y,
    };
    springRef.current = { ...springRef.current, vx: 0, vy: 0 };
    pull(springRef.current);
    event.currentTarget.setPointerCapture(event.pointerId);
    setArmed(null);
    setDragging(true);
  }

  function end(event) {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const result = move(event);
    dragRef.current = null;
    setDragging(false);
    setArmed(null);
    pull({ x: 0, y: 0 });
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.moved && result.sector !== null) activate(result.sector);
  }

  return <div className="launcher-content">
    <div ref={wheelRef} className={`launcher-wheel ${dragging ? 'is-dragging' : ''}`} role="group" aria-label="选择内容类型"
      onPointerLeave={() => { if (!dragRef.current) cancel(); }}>
      <div className="launcher-wheel-plate" aria-hidden="true" />
      {OPTIONS.map(({ name, description, side, Icon }, index) => {
        const selected = dragging ? armed === index : selection === index;
        return <button key={name}
          ref={(node) => { optionRefs.current[index] = node; }} type="button" aria-pressed={selected}
          className={`launcher-option launcher-option--${side}${selected ? ' is-selected' : ''}${dragging && armed === index ? ' is-armed' : ''}`}
          onFocus={() => onSelectionChange(index)}
          onPointerEnter={() => { if (!dragRef.current) { openedRef.current = false; onSelectionChange(index); } }}
          onClick={() => activate(index)}>
          <span className="launcher-option-icon"><Icon aria-hidden="true" /></span>
          <strong>{name}</strong><small>{description}</small>
        </button>;
      })}
      <svg className="launcher-pointer-line" viewBox="0 0 100 100" aria-hidden="true">
        <line ref={lineRef} x1="50" y1="50" x2="50" y2="50" />
      </svg>
      <div className="launcher-center" aria-hidden="true"><span>PASTY</span><small>拖动后松开</small></div>
      <button ref={pointerRef} type="button" className="launcher-pointer" aria-label="拖动指针选择功能" title="按住拖动，松开打开；也可直接点击选项"
        onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={cancel}
        onLostPointerCapture={() => { if (dragRef.current) cancel(); }}
        onClick={() => { if (suppressClickRef.current) { suppressClickRef.current = false; return; } activate(selection); }}>
        <svg ref={arrowRef} className="launcher-pointer-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 19 17 12 14 5 17Z" /></svg>
        {dragging && armed !== null && <svg className="launcher-grip-ring" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="25" /></svg>}
      </button>
    </div>
  </div>;
}
