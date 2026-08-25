import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dismiss16Regular } from '@fluentui/react-icons';
import {
  nearestTextItemIndex,
  normalizeSelectionRange,
  textItemIndexAtPoint,
  textFromSelection,
  wordRangeAt,
} from './pin-text-selection.js';
import { pinImageTransformPlan } from './pin-image-transform.js';
import './pin.css';

const api = window.clipboardAPI;
const HOLD_DELAY = 180;
const MOVE_THRESHOLD = 8;

function PinImage() {
  const initialId = new URLSearchParams(location.search).get('id');
  const [id, setId] = useState(initialId);
  const [entry, setEntry] = useState(null);
  const [textItems, setTextItems] = useState([]);
  const [textImageSize, setTextImageSize] = useState(null);
  const [textMode, setTextMode] = useState(false);
  const [selection, setSelectionState] = useState(null);
  const [pinMenu, setPinMenu] = useState(null);
  const [ocrNotice, setOcrNotice] = useState(null);
  const idRef = useRef(initialId);
  const imageRef = useRef(null);
  const dragRef = useRef(null);
  const pendingPointerRef = useRef(null);
  const textDragRef = useRef(null);
  const holdTimerRef = useRef(null);
  const noticeTimerRef = useRef(null);
  const recognizingRef = useRef(null);
  const textItemsRef = useRef([]);
  const textImageSizeRef = useRef(null);
  const textModeRef = useRef(false);
  const selectionRef = useRef(null);
  const transformingRef = useRef(false);

  function setSelection(next) {
    selectionRef.current = next;
    setSelectionState(next);
  }

  function setSelectableText(items, imageSize) {
    textItemsRef.current = items;
    textImageSizeRef.current = imageSize;
    setTextItems(items);
    setTextImageSize(imageSize);
  }

  function setTextModeState(next) {
    textModeRef.current = next;
    setTextMode(next);
    if (!next) {
      textDragRef.current = null;
      setSelection(null);
      setPinMenu(null);
    }
  }

  function showNotice(next, duration = 0) {
    clearTimeout(noticeTimerRef.current);
    setOcrNotice(next);
    if (duration > 0) noticeTimerRef.current = setTimeout(() => setOcrNotice(null), duration);
  }

  function resetTextInteraction() {
    clearTimeout(holdTimerRef.current);
    clearTimeout(noticeTimerRef.current);
    dragRef.current = null;
    pendingPointerRef.current = null;
    textDragRef.current = null;
    recognizingRef.current = null;
    setSelectableText([], null);
    setTextModeState(false);
    setOcrNotice(null);
  }

  useEffect(() => {
    const unsubscribe = api?.onPinShow((payload) => {
      resetTextInteraction();
      idRef.current = payload.id;
      setId(payload.id);
      setEntry(payload.entry);
    });
    api?.pinRendererReady();
    if (initialId) api?.getScreenshotEntry(initialId).then(setEntry);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const removeCommand = api?.onPinMenuCommand((command) => handlePinMenuCommand(command));
    const removeResult = api?.onPinOperationResult((result) => {
      if (!result?.message) return;
      showNotice({ working: false, success: result.success !== false, message: result.message }, result.success === false ? 3600 : 2400);
    });
    return () => {
      removeCommand?.();
      removeResult?.();
    };
  }, []);

  useEffect(() => {
    const handleWheel = (event) => {
      const activeId = idRef.current;
      if (!activeId) return;
      event.preventDefault();
      api?.zoomPin(activeId, { deltaY: event.deltaY, clientX: event.clientX, clientY: event.clientY });
    };
    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && textModeRef.current) {
        event.preventDefault();
        setTextModeState(false);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        api?.closeCurrentPin();
      } else if (event.ctrlKey && event.key.toLocaleLowerCase() === 'c' && selectionRef.current) {
        event.preventDefault();
        copySelection();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => () => {
    clearTimeout(holdTimerRef.current);
    clearTimeout(noticeTimerRef.current);
  }, []);

  if (!entry) return null;

  function sourcePoint(clientX, clientY, imageSize = textImageSizeRef.current) {
    if (!imageSize) return null;
    return {
      x: clientX / window.innerWidth * imageSize.width,
      y: clientY / window.innerHeight * imageSize.height,
    };
  }

  function menuPosition(clientX, clientY) {
    return {
      left: Math.max(6, Math.min(clientX, window.innerWidth - 154)),
      top: Math.max(6, Math.min(clientY - 48, window.innerHeight - 48)),
    };
  }

  async function enableTextMode(pointer) {
    const activeId = idRef.current;
    let result;
    if (textItemsRef.current.length) {
      result = { success: true, items: textItemsRef.current, imageSize: textImageSizeRef.current };
    } else {
      showNotice({ working: true, message: '正在识别文字位置…' });
      if (!recognizingRef.current) recognizingRef.current = api?.recognizePinText(activeId);
      const recognition = recognizingRef.current;
      result = await recognition;
      if (recognizingRef.current === recognition) recognizingRef.current = null;
      if (idRef.current !== activeId) return;
      if (!result?.success) {
        if (pendingPointerRef.current === pointer) pendingPointerRef.current = null;
        showNotice({ working: false, success: false, message: result?.message || '文字识别失败' }, 3600);
        return;
      }
      setSelectableText(result.items, result.imageSize);
    }
    setTextModeState(true);
    showNotice({ working: false, success: true, message: '拖动选择文字 · Ctrl+C 复制 · Esc 退出' }, 2600);
    if (!pointer || pendingPointerRef.current !== pointer) return;
    const anchorIndex = nearestTextItemIndex(result.items, sourcePoint(pointer.startClientX, pointer.startClientY, result.imageSize));
    const focusIndex = nearestTextItemIndex(result.items, sourcePoint(pointer.clientX, pointer.clientY, result.imageSize));
    pendingPointerRef.current = null;
    if (anchorIndex < 0 || focusIndex < 0) return;
    setSelection(normalizeSelectionRange(anchorIndex, focusIndex));
    if (pointer.pointerDown) {
      textDragRef.current = { pointerId: pointer.pointerId, anchorIndex };
    } else {
      setPinMenu({ ...menuPosition(pointer.clientX, pointer.clientY), fromContextMenu: false });
    }
  }

  function beginPointer(event) {
    if (event.button !== 0 || event.target.closest('button')) return;
    setPinMenu(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (textModeRef.current && textItemsRef.current.length) {
      event.preventDefault();
      const index = textItemIndexAtPoint(textItemsRef.current, sourcePoint(event.clientX, event.clientY));
      if (index < 0) {
        setTextModeState(false);
        dragRef.current = {
          pointerId: event.pointerId,
          offsetX: event.clientX,
          offsetY: event.clientY,
        };
        return;
      }
      if (event.detail >= 2) {
        setSelection(wordRangeAt(textItemsRef.current, index));
        setPinMenu({ ...menuPosition(event.clientX, event.clientY), fromContextMenu: false });
        return;
      }
      textDragRef.current = { pointerId: event.pointerId, anchorIndex: index };
      setSelection({ start: index, end: index });
      return;
    }
    const pending = {
      pointerId: event.pointerId,
      pointerDown: true,
      holdTriggered: false,
      startClientX: event.clientX,
      startClientY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    pendingPointerRef.current = pending;
    if (!textItemsRef.current.length && !recognizingRef.current) {
      recognizingRef.current = api?.recognizePinText(idRef.current);
    }
    holdTimerRef.current = setTimeout(() => {
      pending.holdTriggered = true;
      enableTextMode(pending);
    }, HOLD_DELAY);
  }

  function movePointer(event) {
    const textDrag = textDragRef.current;
    if (textDrag?.pointerId === event.pointerId) {
      const index = nearestTextItemIndex(textItemsRef.current, sourcePoint(event.clientX, event.clientY));
      if (index >= 0) setSelection(normalizeSelectionRange(textDrag.anchorIndex, index));
      return;
    }
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      api?.movePin(idRef.current, { x: event.screenX - drag.offsetX, y: event.screenY - drag.offsetY });
      return;
    }
    const pending = pendingPointerRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    pending.clientX = event.clientX;
    pending.clientY = event.clientY;
    if (pending.holdTriggered) return;
    const distance = Math.hypot(event.clientX - pending.startClientX, event.clientY - pending.startClientY);
    if (distance < MOVE_THRESHOLD) return;
    clearTimeout(holdTimerRef.current);
    pendingPointerRef.current = null;
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: pending.startClientX,
      offsetY: pending.startClientY,
    };
    api?.movePin(idRef.current, { x: event.screenX - pending.startClientX, y: event.screenY - pending.startClientY });
  }

  function endPointer(event) {
    const textDrag = textDragRef.current;
    if (textDrag?.pointerId === event.pointerId) {
      textDragRef.current = null;
      if (selectionRef.current) setPinMenu({ ...menuPosition(event.clientX, event.clientY), fromContextMenu: false });
    }
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    const pending = pendingPointerRef.current;
    if (pending?.pointerId === event.pointerId) {
      pending.pointerDown = false;
      clearTimeout(holdTimerRef.current);
      if (!pending.holdTriggered) pendingPointerRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function cancelPointer(event) {
    clearTimeout(holdTimerRef.current);
    if (pendingPointerRef.current?.pointerId === event.pointerId) pendingPointerRef.current = null;
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    if (textDragRef.current?.pointerId === event.pointerId) textDragRef.current = null;
  }

  async function copySelection() {
    const text = textFromSelection(textItemsRef.current, selectionRef.current);
    if (!text) {
      showNotice({ working: false, success: false, message: '请先拖动选择文字' }, 2600);
      return;
    }
    const result = await api?.copyPinText(idRef.current, text);
    if (result?.success) setTextModeState(false);
    showNotice(result?.success
      ? { working: false, success: true, message: `已复制 ${result.charCount} 个字符` }
      : { working: false, success: false, message: result?.message || '复制失败' }, result?.success ? 2200 : 3600);
  }

  async function transformPinnedImage(operation) {
    const image = imageRef.current;
    if (!image || transformingRef.current) return;
    transformingRef.current = true;
    setPinMenu(null);
    try {
      const plan = pinImageTransformPlan(operation, image.naturalWidth, image.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = plan.width;
      canvas.height = plan.height;
      const context = canvas.getContext('2d');
      context.setTransform(...plan.matrix);
      context.drawImage(image, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');
      const result = await api?.updatePinImage(idRef.current, dataUrl);
      if (!result?.success) {
        showNotice({ working: false, success: false, message: result?.message || '图片变换失败' }, 3600);
        return;
      }
      resetTextInteraction();
      setEntry((current) => current ? {
        ...current,
        width: plan.width,
        height: plan.height,
        content: `${plan.width} × ${plan.height} · PNG`,
        imageUrl: result.imageUrl || dataUrl,
      } : current);
      const labels = {
        'rotate-left': '已向左旋转',
        'rotate-right': '已向右旋转',
        'flip-horizontal': '已水平翻转',
        'flip-vertical': '已垂直翻转',
      };
      showNotice({ working: false, success: true, message: labels[operation] || '图片已更新' }, 1800);
    } catch (error) {
      showNotice({ working: false, success: false, message: `图片变换失败：${error.message}` }, 3600);
    } finally {
      transformingRef.current = false;
    }
  }

  function handlePinMenuCommand(command) {
    if (command === 'copy-selection') copySelection();
    else if (command === 'finish-text-selection') setTextModeState(false);
    else if (['rotate-left', 'rotate-right', 'flip-horizontal', 'flip-vertical'].includes(command)) transformPinnedImage(command);
  }

  function openPinMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    setPinMenu(null);
    api?.showPinContextMenu(idRef.current, {
      hasSelection: Boolean(selectionRef.current),
      textMode: textModeRef.current,
    });
  }

  return <main
    className={`pin-card ${textMode ? 'pin-card--text-mode' : ''}`}
    title={textMode ? '拖动选择文字 · Ctrl+C 复制 · Esc 退出' : '轻按后滑动选字 · 快速拖动移动贴图 · 滚轮缩放'}
    onContextMenu={openPinMenu}
    onPointerDown={beginPointer}
    onPointerMove={movePointer}
    onPointerUp={endPointer}
    onPointerCancel={cancelPointer}
  >
    <img ref={imageRef} src={entry.imageUrl} alt="固定截图" draggable="false" onLoad={() => api?.pinImageReady(id)} />
    {textMode && textImageSize && <div className="pin-text-layer" aria-label="可选择文字层">
      {textItems.map((item, index) => {
        const selected = selection && index >= selection.start && index <= selection.end;
        return <span
          aria-hidden="true"
          className={selected ? 'is-selected' : ''}
          key={`${item.lineId}-${item.wordId}-${index}`}
          style={{
            left: `${item.bbox.x0 / textImageSize.width * 100}%`,
            top: `${item.bbox.y0 / textImageSize.height * 100}%`,
            width: `${(item.bbox.x1 - item.bbox.x0) / textImageSize.width * 100}%`,
            height: `${(item.bbox.y1 - item.bbox.y0) / textImageSize.height * 100}%`,
          }}
        />;
      })}
    </div>}
    <button
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        api?.closeCurrentPin();
      }}
      aria-label="关闭贴图"
    ><Dismiss16Regular /></button>
    {pinMenu && <div className="pin-text-actions" style={{ left: pinMenu.left, top: pinMenu.top }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
      {selection && <button type="button" onClick={copySelection}>复制 <small>Ctrl+C</small></button>}
      {selection && <button type="button" onClick={() => setTextModeState(false)}>完成</button>}
    </div>}
    {ocrNotice && <div className={`pin-ocr-notice ${ocrNotice.success === false ? 'is-error' : ''}`} role="status">
      {ocrNotice.working && <i />}
      <span>{ocrNotice.message}</span>
    </div>}
  </main>;
}

createRoot(document.getElementById('root')).render(<PinImage />);
