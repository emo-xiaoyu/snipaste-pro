import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowRedo20Regular,
  ArrowUndo20Regular,
  Copy20Regular,
  Crop20Regular,
  Dismiss20Regular,
  DrawShape20Regular,
  Line20Regular,
  Pin20Regular,
  Save20Regular,
  TextFontSize20Regular,
  TextT20Regular,
} from '@fluentui/react-icons';
import './screenshot.css';
import {
  normalizedRect,
  pointInsideRect,
  renderStrokes,
  TEXT_FONT_FAMILY,
  TEXT_LINE_HEIGHT,
  textFontSizeFromLineWidth,
  textRectFromDrag,
} from './screenshot-annotations.js';
import { centerSelectionOnPointer } from './screenshot-selection.js';
import { floatingToolbarPosition, insetViewport, selectionViewportRect } from './screenshot-editor-layout.js';

const api = window.clipboardAPI;
const MIN_SELECTION = 24;
const COLORS = ['#ef493f', '#ff9f1c', '#ffe066', '#4ea86b', '#2f80ed', '#161a16', '#ffffff'];
const WIDTHS = [3, 6, 10];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resizeSelection(origin, handle, current, image) {
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.width;
  let bottom = origin.y + origin.height;
  if (handle.includes('w')) left = clamp(current.x, 0, right - MIN_SELECTION);
  if (handle.includes('e')) right = clamp(current.x, left + MIN_SELECTION, image.width);
  if (handle.includes('n')) top = clamp(current.y, 0, bottom - MIN_SELECTION);
  if (handle.includes('s')) bottom = clamp(current.y, top + MIN_SELECTION, image.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function samplePixel(image, current) {
  if (!image || !current) return null;
  const sampler = document.createElement('canvas');
  sampler.width = 1;
  sampler.height = 1;
  const context = sampler.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, Math.floor(current.x), Math.floor(current.y), 1, 1, 0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  const hex = `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  return { r, g, b, hex };
}

function ScreenshotEditor() {
  const canvasRef = useRef(null);
  const imageRef = useRef(null);
  const selectionRef = useRef(null);
  const actionRef = useRef(null);
  const finishingRef = useRef(false);
  const followingSelectionRef = useRef(false);
  const strokesRef = useRef([]);
  const textDraftRef = useRef(null);
  const textInputRef = useRef(null);
  const captureLoadRef = useRef(0);
  const objectUrlRef = useRef('');
  const toolbarRef = useRef(null);
  const [imageSize, setImageSize] = useState(null);
  const [selection, setSelectionState] = useState(null);
  const [autoSelection, setAutoSelection] = useState(null);
  const [tool, setTool] = useState('select');
  const [strokes, setStrokes] = useState([]);
  const [redoStrokes, setRedoStrokes] = useState([]);
  const [textDraft, setTextDraftState] = useState(null);
  const [textBoxPreview, setTextBoxPreview] = useState(null);
  const [color, setColor] = useState(COLORS[0]);
  const [lineWidth, setLineWidth] = useState(WIDTHS[1]);
  const [pointerInfo, setPointerInfo] = useState(null);
  const [followingSelection, setFollowingSelectionState] = useState(false);
  const [editPinId, setEditPinId] = useState(null);
  const [contentInset, setContentInset] = useState(null);
  const [toolbarSize, setToolbarSize] = useState({ width: 540, height: 48 });
  strokesRef.current = strokes;

  function setSelection(next) {
    selectionRef.current = next;
    setSelectionState(next);
  }

  function setFollowingSelection(next) {
    followingSelectionRef.current = next;
    setFollowingSelectionState(next);
  }

  function setTextDraft(next) {
    textDraftRef.current = next;
    setTextDraftState(next);
  }

  function resetEditor(payload) {
    const { imageUrl = '', imageBytes, initialSelection, ...task } = payload || {};
    const loadId = captureLoadRef.current + 1;
    captureLoadRef.current = loadId;
    const preset = initialSelection || null;
    setStrokes([]);
    setRedoStrokes([]);
    setTextDraft(null);
    setTextBoxPreview(null);
    setImageSize(null);
    setSelection(preset);
    setAutoSelection(preset);
    setFollowingSelection(task.followSelection === false ? false : Boolean(preset));
    setTool(task.initialTool || 'select');
    setPointerInfo(null);
    finishingRef.current = false;
    setEditPinId(task.editPinId || null);
    setContentInset(task.contentInset || null);
    imageRef.current = null;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const pngBytes = imageBytes?.type === 'Buffer' ? new Uint8Array(imageBytes.data) : imageBytes;
    objectUrlRef.current = pngBytes
      ? URL.createObjectURL(new Blob([pngBytes], { type: 'image/png' }))
      : '';
    const source = objectUrlRef.current || imageUrl;
    if (!source) return;
    const image = new Image();
    image.onload = () => {
      if (captureLoadRef.current !== loadId) return;
      imageRef.current = image;
      setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        if (preset) {
          context.save();
          context.fillStyle = 'rgba(15, 18, 14, .54)';
          context.beginPath();
          context.rect(0, 0, canvas.width, canvas.height);
          context.rect(preset.x, preset.y, preset.width, preset.height);
          context.fill('evenodd');
          context.strokeStyle = '#f7fff3';
          context.lineWidth = 2;
          context.strokeRect(preset.x, preset.y, preset.width, preset.height);
          context.restore();
        }
      }
      let announced = false;
      const announceReady = () => {
        if (announced || captureLoadRef.current !== loadId) return;
        announced = true;
        api?.screenshotReady();
      };
      requestAnimationFrame(announceReady);
      setTimeout(announceReady, 28);
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = '';
      }
    };
    image.src = source;
  }

  useEffect(() => {
    const unsubscribe = api?.onScreenshotBegin(resetEditor);
    api?.screenshotRendererReady();
    return () => {
      unsubscribe?.();
      captureLoadRef.current += 1;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  useEffect(() => api?.onScreenshotPinRequest(() => finish(true, true)), []);

  useEffect(draw, [selection, strokes, imageSize, tool]);

  useEffect(() => {
    if (!textDraft) return undefined;
    const focusInput = () => {
      const input = textInputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    };
    const frame = requestAnimationFrame(focusInput);
    const timer = setTimeout(focusInput, 0);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [Boolean(textDraft)]);

  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return undefined;
    const updateSize = () => {
      const rect = toolbar.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setToolbarSize((current) => current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height });
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [Boolean(selection)]);

  useEffect(() => {
    const keys = (event) => {
      const key = event.key.toLocaleLowerCase();
      const editingText = Boolean(textDraftRef.current) && (
        event.target === textInputRef.current
        || document.activeElement === textInputRef.current
      );
      if (editingText) {
        if (event.key === 'Escape') { event.preventDefault(); cancelTextDraft(); }
        else if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); commitTextDraft(); }
        return;
      }
      if (event.key === 'Escape' && textDraftRef.current) { event.preventDefault(); cancelTextDraft(); }
      else if (event.key === 'Escape') api?.closeScreenshotEditor();
      else if (event.key === 'F4' && selectionRef.current) { event.preventDefault(); finish(true, true); }
      else if (event.key === 'Enter' && selectionRef.current) { event.preventDefault(); finish(false, true); }
      else if (event.ctrlKey && key === 'c' && selectionRef.current) { event.preventDefault(); finish(false, true); }
      else if (event.ctrlKey && key === 'p' && selectionRef.current) { event.preventDefault(); finish(true, true); }
      else if (event.ctrlKey && (key === 'y' || (event.shiftKey && key === 'z'))) { event.preventDefault(); redo(); }
      else if (event.ctrlKey && key === 'z') { event.preventDefault(); undo(); }
      else if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key) && selectionRef.current && !strokes.length) {
        event.preventDefault();
        nudgeSelection(key, event.shiftKey);
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [selection, strokes, redoStrokes]);

  function point(event) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) * canvas.width / rect.width, 0, canvas.width - 1),
      y: clamp((event.clientY - rect.top) * canvas.height / rect.height, 0, canvas.height - 1),
    };
  }

  function updatePointer(current, event) {
    const pixel = samplePixel(imageRef.current, current);
    setPointerInfo({ ...current, ...pixel, clientX: event.clientX, clientY: event.clientY });
  }

  function handleAt(current) {
    const currentSelection = selectionRef.current;
    const canvas = canvasRef.current;
    if (!currentSelection || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const hit = 12 * canvas.width / rect.width;
    const xs = { w: currentSelection.x, e: currentSelection.x + currentSelection.width };
    const ys = { n: currentSelection.y, s: currentSelection.y + currentSelection.height };
    const nearX = Math.abs(current.x - xs.w) <= hit ? 'w' : Math.abs(current.x - xs.e) <= hit ? 'e' : '';
    const nearY = Math.abs(current.y - ys.n) <= hit ? 'n' : Math.abs(current.y - ys.s) <= hit ? 's' : '';
    if (nearX && nearY) return `${nearY}${nearX}`;
    if (nearX && current.y >= ys.n - hit && current.y <= ys.s + hit) return nearX;
    if (nearY && current.x >= xs.w - hit && current.x <= xs.e + hit) return nearY;
    return null;
  }

  function isInside(current, value = selectionRef.current) {
    return value && current.x >= value.x && current.x <= value.x + value.width && current.y >= value.y && current.y <= value.y + value.height;
  }

  function draw() {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    renderStrokes(context, strokes);
    if (selection) {
      context.save();
      context.fillStyle = 'rgba(15, 18, 14, .54)';
      context.beginPath(); context.rect(0, 0, canvas.width, canvas.height); context.rect(selection.x, selection.y, selection.width, selection.height); context.fill('evenodd');
      context.strokeStyle = tool === 'select' ? '#f7fff3' : 'rgba(255,255,255,.84)';
      context.lineWidth = 2; context.setLineDash(tool === 'select' ? [] : [8, 5]);
      context.strokeRect(selection.x, selection.y, selection.width, selection.height); context.restore();
    }
  }

  function beginStroke(current) {
    const base = { tool, color, lineWidth };
    return tool === 'pen' ? { ...base, points: [current] } : { ...base, start: current, end: current };
  }

  function cancelTextDraft() {
    setTextDraft(null);
    setTextBoxPreview(null);
  }

  function commitTextDraft() {
    const draft = textDraftRef.current;
    if (!draft) return null;
    setTextDraft(null);
    setTextBoxPreview(null);
    if (!draft.text.trim()) return null;
    const stroke = { tool: 'text', rect: draft.rect, text: draft.text.replace(/\r\n?/g, '\n'), color: draft.color, fontSize: draft.fontSize };
    const next = [...strokesRef.current, stroke];
    strokesRef.current = next;
    setStrokes(next);
    setRedoStrokes([]);
    return stroke;
  }

  function onTextKeyDown(event) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelTextDraft();
    } else if (event.ctrlKey && event.key === 'Enter') {
      event.preventDefault();
      commitTextDraft();
    }
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    if (textDraftRef.current) commitTextDraft();
    setFollowingSelection(false);
    const current = point(event);
    canvasRef.current.setPointerCapture(event.pointerId);
    if (tool === 'select' || !selectionRef.current) {
      const currentSelection = selectionRef.current;
      const handle = handleAt(current);
      if (handle) actionRef.current = { type: 'resize', handle, origin: { ...currentSelection } };
      else if (event.altKey && isInside(current, currentSelection)) actionRef.current = { type: 'move', start: current, origin: { ...currentSelection } };
      else actionRef.current = { type: 'select', start: current, fallback: currentSelection ? { ...currentSelection } : null };
      return;
    }
    if (!isInside(current)) return;
    if (tool === 'text') {
      actionRef.current = { type: 'text-box', start: current, end: current };
      setTextBoxPreview({ x: current.x, y: current.y, width: 0, height: 0 });
      return;
    }
    actionRef.current = { type: 'draw', stroke: beginStroke(current) };
  }

  function onPointerMove(event) {
    const current = point(event);
    updatePointer(current, event);
    const action = actionRef.current;
    if (!action) {
      if (followingSelectionRef.current && tool === 'select' && selectionRef.current && imageRef.current) {
        setSelection(centerSelectionOnPointer(selectionRef.current, current, {
          width: imageRef.current.naturalWidth,
          height: imageRef.current.naturalHeight,
        }));
      }
      return;
    }
    const image = imageRef.current;
    if (action.type === 'select') setSelection(normalizedRect(action.start, current));
    else if (action.type === 'move') {
      setSelection({
        ...action.origin,
        x: clamp(action.origin.x + current.x - action.start.x, 0, image.naturalWidth - action.origin.width),
        y: clamp(action.origin.y + current.y - action.start.y, 0, image.naturalHeight - action.origin.height),
      });
    } else if (action.type === 'resize') setSelection(resizeSelection(action.origin, action.handle, current, { width: image.naturalWidth, height: image.naturalHeight }));
    else if (action.type === 'text-box') {
      action.end = pointInsideRect(current, selectionRef.current);
      setTextBoxPreview(normalizedRect(action.start, action.end));
    }
    else {
      if (action.stroke.tool === 'pen') action.stroke.points.push(current); else action.stroke.end = current;
      setStrokes((items) => [...items.filter((item) => item !== action.stroke), action.stroke]);
    }
  }

  function onPointerUp() {
    const action = actionRef.current;
    if (action?.type === 'text-box') {
      const rect = textRectFromDrag(action.start, action.end, selectionRef.current);
      setTextBoxPreview(null);
      setTextDraft({ rect, text: '', color, fontSize: textFontSizeFromLineWidth(lineWidth) });
      setRedoStrokes([]);
      actionRef.current = null;
      return;
    }
    if (selectionRef.current?.width < MIN_SELECTION || selectionRef.current?.height < MIN_SELECTION) {
      setSelection(action?.type === 'select' ? action.fallback : null);
    }
    if (action?.type === 'draw') setRedoStrokes([]);
    actionRef.current = null;
  }

  function undo() {
    setStrokes((items) => {
      if (!items.length) return items;
      setRedoStrokes((redoItems) => [items.at(-1), ...redoItems]);
      return items.slice(0, -1);
    });
  }

  function redo() {
    setRedoStrokes((items) => {
      if (!items.length) return items;
      setStrokes((strokeItems) => [...strokeItems, items[0]]);
      return items.slice(1);
    });
  }

  function nudgeSelection(key, resize) {
    const current = selectionRef.current;
    const image = imageRef.current;
    if (!current || !image) return;
    setFollowingSelection(false);
    const dx = key === 'arrowleft' ? -1 : key === 'arrowright' ? 1 : 0;
    const dy = key === 'arrowup' ? -1 : key === 'arrowdown' ? 1 : 0;
    if (!resize) {
      setSelection({ ...current, x: clamp(current.x + dx, 0, image.naturalWidth - current.width), y: clamp(current.y + dy, 0, image.naturalHeight - current.height) });
      return;
    }
    setSelection({
      ...current,
      width: clamp(current.width + dx, MIN_SELECTION, image.naturalWidth - current.x),
      height: clamp(current.height + dy, MIN_SELECTION, image.naturalHeight - current.y),
    });
  }

  function goBack(event) {
    event.preventDefault();
    if (textDraftRef.current) { cancelTextDraft(); return; }
    if (textBoxPreview) { setTextBoxPreview(null); actionRef.current = null; return; }
    if (actionRef.current) { actionRef.current = null; return; }
    if (strokes.length) { undo(); return; }
    if (followingSelectionRef.current) { setFollowingSelection(false); setSelection(null); return; }
    if (selectionRef.current && autoSelection) {
      setSelection(centerSelectionOnPointer(autoSelection, point(event), {
        width: imageRef.current.naturalWidth,
        height: imageRef.current.naturalHeight,
      }));
      setFollowingSelection(true);
      return;
    }
    if (selectionRef.current) { setFollowingSelection(false); setSelection(null); return; }
    api?.closeScreenshotEditor();
  }

  function chooseTool(next) {
    if (textDraftRef.current && next !== 'text') commitTextDraft();
    if (next !== 'select') setFollowingSelection(false);
    setTool(next);
  }

  async function finish(pin, copy = true) {
    const crop = selectionRef.current;
    if (!crop || finishingRef.current) return;
    commitTextDraft();
    finishingRef.current = true;
    const image = imageRef.current;
    const output = document.createElement('canvas');
    output.width = Math.round(crop.width); output.height = Math.round(crop.height);
    const context = output.getContext('2d');
    context.save();
    context.scale(output.width / crop.width, output.height / crop.height);
    context.translate(-crop.x, -crop.y);
    context.drawImage(image, 0, 0);
    renderStrokes(context, strokesRef.current);
    context.restore();
    const result = await api?.saveScreenshot(output.toDataURL('image/png'), { pin, copy, crop, editPinId });
    if (result && !result.success) {
      finishingRef.current = false;
    }
  }

  const editorViewport = { width: window.innerWidth, height: window.innerHeight };
  const canvasStyle = contentInset ? insetViewport(editorViewport, contentInset) : undefined;
  const selectionStyle = selection && imageSize
    ? selectionViewportRect(selection, imageSize, editorViewport, contentInset || {})
    : null;
  const toolbarLayout = floatingToolbarPosition(selectionStyle, editorViewport, toolbarSize);
  const textBoxPreviewStyle = textBoxPreview && imageSize
    ? selectionViewportRect(textBoxPreview, imageSize, editorViewport, contentInset || {})
    : null;
  const textDraftStyle = textDraft && imageSize
    ? selectionViewportRect(textDraft.rect, imageSize, editorViewport, contentInset || {})
    : null;
  const textScale = textDraftStyle && textDraft?.rect.width ? textDraftStyle.width / textDraft.rect.width : 1;
  const infoStyle = pointerInfo ? {
    left: clamp(pointerInfo.clientX + 16, 8, window.innerWidth - 190),
    top: clamp(pointerInfo.clientY + 18, 8, window.innerHeight - 70),
  } : null;

  return (
    <main className={`shot-stage shot-stage--${tool} ${editPinId ? 'shot-stage--pin-edit' : ''}`} onContextMenu={goBack}>
      {contentInset && <div className="pin-edit-shadow" style={canvasStyle} aria-hidden="true" />}
      <canvas
        ref={canvasRef}
        style={canvasStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => tool !== 'text' && selectionRef.current && finish(false, true)}
      />
      {textBoxPreviewStyle && <div className="shot-text-box-preview" style={textBoxPreviewStyle} />}
      {textDraftStyle && <textarea
        ref={textInputRef}
        className="shot-text-editor"
        value={textDraft.text}
        onChange={(event) => setTextDraft({ ...textDraftRef.current, text: event.target.value })}
        onKeyDown={onTextKeyDown}
        onBlur={commitTextDraft}
        onContextMenu={(event) => event.stopPropagation()}
        placeholder="输入文字"
        spellCheck={false}
        style={{
          ...textDraftStyle,
          color: textDraft.color,
          fontFamily: TEXT_FONT_FAMILY,
          fontSize: Math.max(12, textDraft.fontSize * textScale),
          lineHeight: TEXT_LINE_HEIGHT,
        }}
      />}
      {selectionStyle && tool === 'select' && <div className="selection-box" style={selectionStyle}>
        {['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((handle) => <span className={`selection-handle selection-handle--${handle}`} key={handle} />)}
        <span className="selection-size">{Math.round(selection.width)} × {Math.round(selection.height)}</span>
      </div>}
      {pointerInfo && <div className="pixel-info" style={infoStyle}>
        <i style={{ background: pointerInfo.hex }} />
        <span>{pointerInfo.hex}</span>
        <small>RGB {pointerInfo.r}, {pointerInfo.g}, {pointerInfo.b}</small>
      </div>}
      {!selection && <div className="shot-hint"><Crop20Regular /><strong>拖动选择截图区域</strong><span>右键返回 · Esc 取消</span></div>}
      {selection && <div
        ref={toolbarRef}
        className={`shot-toolbar shot-toolbar--${toolbarLayout?.placement || 'below'}`}
        style={toolbarLayout ? { left: toolbarLayout.left, top: toolbarLayout.top } : undefined}
      >
        <button className={tool === 'select' ? 'active' : ''} disabled={strokes.length > 0} onClick={() => chooseTool('select')} title={strokes.length ? '已开始标注，选区已锁定' : '调整选区'}><Crop20Regular /></button>
        <button className={tool === 'pen' ? 'active' : ''} onClick={() => chooseTool('pen')} title="画笔"><Line20Regular /></button>
        <button className={tool === 'arrow' ? 'active' : ''} onClick={() => chooseTool('arrow')} title="箭头"><DrawShape20Regular /></button>
        <button className={tool === 'rect' ? 'active' : ''} onClick={() => chooseTool('rect')} title="矩形"><span className="rect-icon" /></button>
        <button className={tool === 'ellipse' ? 'active' : ''} onClick={() => chooseTool('ellipse')} title="椭圆"><span className="ellipse-icon" /></button>
        <button className={tool === 'text' ? 'active' : ''} onClick={() => chooseTool('text')} title="文字"><TextT20Regular /></button>
        <span className="separator" />
        <div className="color-control" title="标注颜色">
          <button className="color-trigger" aria-label="标注颜色"><i style={{ background: color }} /></button>
          <div className="color-popover">{COLORS.map((item) => <button key={item} className={color === item ? 'selected' : ''} style={{ '--swatch': item }} onClick={() => setColor(item)} aria-label={item} />)}</div>
        </div>
        <div className="width-control" title={tool === 'text' ? '文字大小' : '线条粗细'}>
          <button className={`width-trigger ${tool === 'text' ? 'width-trigger--text' : ''}`} aria-label={tool === 'text' ? '文字大小' : '线条粗细'}>{tool === 'text' ? <TextFontSize20Regular /> : <i style={{ height: Math.max(2, lineWidth / 2) }} />}</button>
          <div className={`width-popover ${tool === 'text' ? 'width-popover--text' : ''}`}>{WIDTHS.map((item) => <button key={item} className={lineWidth === item ? 'selected' : ''} onClick={() => setLineWidth(item)}>{tool === 'text' ? <span style={{ fontSize: 10 + item }}>A</span> : <i style={{ height: Math.max(2, item / 2) }} />}</button>)}</div>
        </div>
        <button onClick={undo} disabled={!strokes.length} title="撤销 · Ctrl+Z"><ArrowUndo20Regular /></button>
        <button onClick={redo} disabled={!redoStrokes.length} title="重做 · Ctrl+Y"><ArrowRedo20Regular /></button>
        <span className="separator" />
        <button onClick={() => finish(false, false)} title="保存截图"><Save20Regular /></button>
        <button onClick={() => finish(false, true)} title="复制截图 · Enter / Ctrl+C"><Copy20Regular /></button>
        <button className="primary" onClick={() => finish(true, true)} title="复制并原位贴图 · F4"><Pin20Regular /></button>
        <button onClick={() => api?.closeScreenshotEditor()} title="取消 · Esc"><Dismiss20Regular /></button>
      </div>}
      {selection && tool === 'select' && !strokes.length && <div className="keyboard-tip">{followingSelection
        ? '移动鼠标定位预选区 · 左键拖动自定义选区 · F4 复制并原位贴图'
        : '从任意位置拖动重新框选 · 拖边角调大小 · Alt 拖动选区 · F4 复制并原位贴图'}</div>}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<ScreenshotEditor />);
