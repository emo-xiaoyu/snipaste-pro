import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChevronLeft20Regular, ChevronRight20Regular, Dismiss20Regular, Image20Regular, Pin20Regular } from '@fluentui/react-icons';
import { eventMatchesAccelerator } from './shortcut-utils.js';
import './screenshot-history.css';

const api = window.clipboardAPI;

function timeLabel(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

function ScreenshotHistory() {
  const [entries, setEntries] = useState([]);
  const [index, setIndex] = useState(0);
  const [pinShortcut, setPinShortcut] = useState('Enter');
  const active = entries[index];

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

  return (
    <main className="history-stage">
      <section className="history-shell">
        <header>
          <div><span className="eyebrow">截图历史</span><strong>{active ? timeLabel(active.createdAt) : '还没有截图'}</strong></div>
          <div className="history-count">{position}</div>
          <button className="icon-button" onClick={() => api?.closeScreenshotHistory()} aria-label="关闭"><Dismiss20Regular /></button>
        </header>
        <div className="history-preview">
          {active ? <img src={active.imageUrl} alt={active.title || '历史截图'} /> : <div className="history-empty"><Image20Regular /><strong>还没有截图</strong><span>按 Alt+Shift+S 开始第一张截图</span></div>}
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
