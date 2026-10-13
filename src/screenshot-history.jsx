import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChevronLeft20Regular, ChevronRight20Regular, Dismiss20Regular, Image20Regular, Pin20Regular } from '@fluentui/react-icons';
import { eventMatchesAccelerator } from './shortcut-utils.js';
import './screenshot-history.css';

const api = window.clipboardAPI;
// Full-resolution screenshots are fetched one at a time on demand; a small
// LRU of object URLs makes flipping back and forth instant without keeping
// every historical image in memory.
const FULL_IMAGE_CACHE_LIMIT = 10;

function timeLabel(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

function ScreenshotHistory() {
  const [entries, setEntries] = useState([]);
  const [index, setIndex] = useState(0);
  const [pinShortcut, setPinShortcut] = useState('Enter');
  const [activeImage, setActiveImage] = useState(null);
  const fullCacheRef = useRef(new Map());
  const active = entries[index];

  async function loadFullImage(id) {
    const cache = fullCacheRef.current;
    const cached = cache.get(id);
    if (cached) {
      cache.delete(id);
      cache.set(id, cached);
      setActiveImage({ id, url: cached, loading: false });
      return;
    }
    setActiveImage((current) => (current?.id === id ? current : { id, url: '', loading: true }));
    try {
      const entry = await api?.getScreenshotEntry(id);
      if (!entry || (!entry.imageBytes && !entry.imageUrl)) {
        setActiveImage((current) => (current?.id === id ? { id, url: '', loading: false, error: true } : current));
        return;
      }
      const url = entry.imageBytes
        ? URL.createObjectURL(new Blob([entry.imageBytes], { type: 'image/png' }))
        : entry.imageUrl;
      cache.set(id, url);
      while (cache.size > FULL_IMAGE_CACHE_LIMIT) {
        const oldestId = cache.keys().next().value;
        const oldestUrl = cache.get(oldestId);
        cache.delete(oldestId);
        if (oldestUrl.startsWith('blob:')) URL.revokeObjectURL(oldestUrl);
      }
      setActiveImage((current) => (current?.id === id ? { id, url, loading: false } : current));
    } catch {
      setActiveImage((current) => (current?.id === id ? { id, url: '', loading: false, error: true } : current));
    }
  }

  useEffect(() => {
    if (active) loadFullImage(active.id);
  }, [active?.id]);

  useEffect(() => () => {
    for (const url of fullCacheRef.current.values()) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    }
  }, []);

  async function refresh() {
    const result = await api?.getScreenshotHistory();
    setEntries(result?.entries || []);
    setPinShortcut(result?.historyPinShortcut || 'Enter');
    setIndex((current) => Math.min(current, Math.max(0, (result?.entries?.length || 1) - 1)));
  }

  useEffect(() => {
    refresh();
    return api?.onScreenshotHistoryRefresh(refresh);
  }, []);
  const position = useMemo(() => entries.length ? `${index + 1} / ${entries.length}` : '0 / 0', [entries.length, index]);

  function move(delta) {
    if (!entries.length) return;
    setIndex((current) => (current + delta + entries.length) % entries.length);
  }

  useEffect(() => {
    const keys = async (event) => {
      if (!event.repeat && active && eventMatchesAccelerator(event, pinShortcut)) { event.preventDefault(); await api?.pinScreenshot(active.id); }
      else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); move(1); }
      else if (event.key === 'Escape') api?.closeScreenshotHistory();
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [active, entries.length, pinShortcut]);

  const previewSrc = activeImage?.id === active?.id && activeImage?.url
    ? activeImage.url
    : active?.imageUrl;

  return (
    <main className="history-stage">
      <section className="history-shell">
        <header>
          <div><span className="eyebrow">截图历史</span><strong>{active ? timeLabel(active.createdAt) : '还没有截图'}</strong></div>
          <div className="history-count">{position}</div>
          <button className="icon-button" onClick={() => api?.closeScreenshotHistory()} aria-label="关闭"><Dismiss20Regular /></button>
        </header>
        <div className="history-preview">
          {active ? (
            <img
              className={activeImage?.loading ? 'is-loading' : ''}
              src={previewSrc}
              alt={active.title || '历史截图'}
            />
          ) : <div className="history-empty"><Image20Regular /><strong>还没有截图</strong><span>按 Alt+Shift+S 开始第一张截图</span></div>}
          {active && activeImage?.error && <div className="history-missing">图片文件已不存在</div>}
          {entries.length > 1 && <><button className="nav nav--prev" onClick={() => move(-1)} aria-label="上一张"><ChevronLeft20Regular /></button><button className="nav nav--next" onClick={() => move(1)} aria-label="下一张"><ChevronRight20Regular /></button></>}
        </div>
        <footer>
          <span><kbd>↑</kbd><kbd>↓</kbd> 切换截图</span>
          <span><kbd>{pinShortcut}</kbd> 钉到桌面</span>
          <button disabled={!active} onClick={() => active && api?.pinScreenshot(active.id)}><Pin20Regular />钉住当前截图</button>
        </footer>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<ScreenshotHistory />);
