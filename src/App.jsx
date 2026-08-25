import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Add20Regular,
  Code20Regular,
  Delete20Regular,
  Dismiss20Regular,
  Document20Regular,
  Globe20Regular,
  Image20Regular,
  Pin20Filled,
  Pin20Regular,
  Search24Regular,
  Settings20Regular,
  TextDescription20Regular,
} from '@fluentui/react-icons';
import { acceleratorFromEvent } from './shortcut-utils.js';

const demoEntries = [
  { id: 'demo-1', type: 'code', title: 'npm run dev', content: 'npm run dev', createdAt: Date.now() - 1000, pinned: true },
  { id: 'demo-2', type: 'url', title: '项目管理后台', content: 'https://admin.example.com/dashboard', createdAt: Date.now() - 120000, pinned: false },
  { id: 'demo-3', type: 'text', title: '收到，我稍后整理发你', content: '收到，我稍后整理发你', createdAt: Date.now() - 180000, pinned: false },
  { id: 'demo-4', type: 'image', title: '截图 2026-08-11 10.24.31.png', content: '1920 × 1080 · PNG', imageUrl: '/assets/sample-mountain.png', createdAt: Date.now() - 300000, pinned: false },
  { id: 'demo-5', type: 'code', title: 'SELECT * FROM users WHERE active = 1;', content: 'SELECT * FROM users WHERE active = 1;', createdAt: Date.now() - 480000, pinned: false },
  { id: 'demo-6', type: 'text', title: 'TODO: 优化登录校验逻辑并补充单元测试', content: 'TODO: 优化登录校验逻辑并补充单元测试', createdAt: Date.now() - 900000, pinned: false },
];

const tabs = [
  { id: 'recent', label: '最近' },
  { id: 'pinned', label: '常用' },
  { id: 'image', label: '图片' },
];

const typeMeta = {
  text: { icon: TextDescription20Regular, label: '文本' },
  code: { icon: Code20Regular, label: '指令' },
  url: { icon: Globe20Regular, label: '网址' },
  image: { icon: Image20Regular, label: '图片' },
  file: { icon: Document20Regular, label: '文件' },
};

const defaultPreferences = {
  captureText: true,
  captureImages: true,
  captureFiles: true,
  captureRichText: true,
  trackSource: true,
  mergeDuplicates: true,
  protectSensitive: true,
  showCopyToast: true,
  autoRemoteDelay: true,
  pasteDelay: 35,
  remotePasteDelay: 320,
  historyLimit: 120,
};

const defaultScreenshotShortcuts = {
  capture: 'Alt+Shift+S',
  quickPin: 'Alt+Shift+P',
  history: 'Alt+Shift+V',
  historyPin: 'Enter',
};

function relativeTime(timestamp) {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(timestamp);
}

function useClipboardState() {
  const api = window.clipboardAPI;
  const [entries, setEntries] = useState(api ? [] : demoEntries);
  const [shortcut, setShortcut] = useState('Alt+V');
  const [screenshotShortcuts, setScreenshotShortcuts] = useState(defaultScreenshotShortcuts);
  const [preferences, setPreferences] = useState(defaultPreferences);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!api) return undefined;
    api.getState().then((next) => {
      setEntries(next.entries || []);
      setShortcut(next.shortcut || 'Alt+V');
      setScreenshotShortcuts({ ...defaultScreenshotShortcuts, ...(next.screenshotShortcuts || {}) });
      setPreferences({ ...defaultPreferences, ...(next.preferences || {}) });
    });
    return api.onStateChanged((next) => {
      setEntries(next.entries || []);
      setShortcut(next.shortcut || 'Alt+V');
      setScreenshotShortcuts({ ...defaultScreenshotShortcuts, ...(next.screenshotShortcuts || {}) });
      setPreferences({ ...defaultPreferences, ...(next.preferences || {}) });
      if (next.notice) setNotice(next.notice);
    });
  }, [api]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  return { api, entries, setEntries, shortcut, setShortcut, screenshotShortcuts, setScreenshotShortcuts, preferences, setPreferences, notice, setNotice };
}

function EntryIcon({ type }) {
  const Icon = (typeMeta[type] || typeMeta.text).icon;
  return <span className={`entry-icon entry-icon--${type}`}><Icon /></span>;
}

function AddDialog({ onClose, onSubmit }) {
  const [type, setType] = useState('text');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  function submit(event) {
    event.preventDefault();
    onSubmit({ type, title, content });
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="dialog" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-heading">
          <div><span className="eyebrow">永久保存</span><h2>添加常用内容</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><Dismiss20Regular /></button>
        </div>
        <label>
          内容类型
          <select value={type} onChange={(event) => setType(event.target.value)}>
            <option value="text">文本</option>
            <option value="code">指令</option>
            <option value="url">网址</option>
            <option value="image">当前剪贴板图片</option>
          </select>
        </label>
        <label>
          名称（可选）
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：启动本地服务" autoFocus />
        </label>
        {type !== 'image' && (
          <label>
            要粘贴的内容
            <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="输入以后需要快速粘贴的内容…" rows="5" />
          </label>
        )}
        {type === 'image' && <p className="dialog-hint">保存前请先复制一张图片，它会被安全地保存到本机。</p>}
        <div className="dialog-actions">
          <button type="button" className="button button--ghost" onClick={onClose}>取消</button>
          <button type="submit" className="button button--primary">保存到常用</button>
        </div>
      </form>
    </div>
  );
}

const preferenceOptions = [
  ['captureText', '记录文本', '普通文本、网址与命令'],
  ['captureImages', '记录图片', '保存图片原图与尺寸'],
  ['captureFiles', '记录文件', '记住从资源管理器复制的文件'],
  ['captureRichText', '保留富文本', '粘贴时尽量恢复 HTML 格式'],
  ['trackSource', '记录来源', '保存来源应用与窗口标题'],
  ['mergeDuplicates', '合并重复内容', '只保留一条并累计复制次数'],
  ['protectSensitive', '保护敏感内容', '自动跳过密码、令牌与卡号'],
  ['showCopyToast', '显示复制提示', '右下角短暂显示已保存状态'],
  ['autoRemoteDelay', '远控自动适配', '识别远程控制窗口并留出同步时间'],
];

function ShortcutRecorder({ label, value, placeholder, onChange, onRecordingChange, allowSingleKey = false }) {
  const [recording, setRecording] = useState(false);

  async function changeRecording(next) {
    setRecording(next);
    await onRecordingChange?.(next);
  }

  function keyDown(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Backspace' || event.key === 'Delete') {
      onChange('');
      return;
    }
    const accelerator = acceleratorFromEvent(event, { allowSingleKey });
    if (accelerator) onChange(accelerator);
  }

  return (
    <label className={recording ? 'shortcut-recorder is-recording' : 'shortcut-recorder'}>
      {label}
      <span className="shortcut-input-wrap">
        <input
          value={value}
          placeholder={placeholder}
          readOnly
          onFocus={() => changeRecording(true)}
          onBlur={() => changeRecording(false)}
          onKeyDown={keyDown}
          aria-label={`${label}快捷键`}
        />
        <span className="shortcut-recording-state">{recording ? (allowSingleKey ? '请按按键' : '请按组合键') : '点击录制'}</span>
      </span>
    </label>
  );
}

function SettingsDialog({ initialShortcut, initialScreenshotShortcuts, initialPreferences, onClose, onSave, onQuit }) {
  const [shortcut, setShortcut] = useState(initialShortcut);
  const [screenshotShortcuts, setScreenshotShortcuts] = useState(initialScreenshotShortcuts);
  const [preferences, setPreferences] = useState(initialPreferences);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const update = (key, value) => setPreferences((current) => ({ ...current, [key]: value }));
  const updateScreenshotShortcut = (key, value) => setScreenshotShortcuts((current) => ({ ...current, [key]: value }));

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setSaveError('');
    await window.clipboardAPI?.setShortcutRecording(false);
    const result = await onSave(shortcut, screenshotShortcuts, preferences);
    setSaving(false);
    if (result?.success === false) setSaveError(result.message || '快捷键保存失败');
  }

  const recordingChanged = (active) => window.clipboardAPI?.setShortcutRecording(active);
  async function close() {
    await window.clipboardAPI?.setShortcutRecording(false);
    onClose();
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={close}>
      <form className="dialog settings-dialog" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-heading">
          <div><span className="eyebrow">偏好设置</span><h2>快捷键与复制设置</h2></div>
          <button type="button" className="icon-button" onClick={close} aria-label="关闭"><Dismiss20Regular /></button>
        </div>
        <div className="settings-scroll">
          <section className="settings-section shortcut-section">
            <span className="settings-label">常用快捷键</span>
            <div className="settings-grid shortcut-grid">
              <ShortcutRecorder label="唤出剪贴板" value={shortcut} onChange={setShortcut} onRecordingChange={recordingChanged} placeholder="Alt+V" />
              <ShortcutRecorder label="开始截图" value={screenshotShortcuts.capture} onChange={(value) => updateScreenshotShortcut('capture', value)} onRecordingChange={recordingChanged} placeholder="Alt+Shift+S" />
              <ShortcutRecorder label="快速截图并贴桌面" value={screenshotShortcuts.quickPin} onChange={(value) => updateScreenshotShortcut('quickPin', value)} onRecordingChange={recordingChanged} placeholder="Alt+Shift+P" />
              <ShortcutRecorder label="截图历史" value={screenshotShortcuts.history} onChange={(value) => updateScreenshotShortcut('history', value)} onRecordingChange={recordingChanged} placeholder="Alt+Shift+V" />
              <ShortcutRecorder label="历史截图钉到桌面" value={screenshotShortcuts.historyPin} onChange={(value) => updateScreenshotShortcut('historyPin', value)} onRecordingChange={recordingChanged} placeholder="Enter" allowSingleKey />
            </div>
            <small className="settings-note">点击输入框后直接录制；“历史截图钉到桌面”支持 Enter、字母等单键且只在历史窗口内生效。Backspace 清空。</small>
          </section>
          <section className="settings-section">
            <span className="settings-label">自动捕获</span>
            <div className="settings-list">
              {preferenceOptions.map(([key, title, description]) => (
                <label className="setting-row" key={key}>
                  <span><strong>{title}</strong><small>{description}</small></span>
                  <input type="checkbox" checked={Boolean(preferences[key])} onChange={(event) => update(key, event.target.checked)} />
                  <span className="switch" aria-hidden="true" />
                </label>
              ))}
            </div>
          </section>
          <section className="settings-section settings-grid">
            <label>
              历史上限
              <select value={preferences.historyLimit} onChange={(event) => update('historyLimit', Number(event.target.value))}>
                <option value="60">60 条</option>
                <option value="120">120 条</option>
                <option value="300">300 条</option>
                <option value="500">500 条</option>
              </select>
            </label>
          </section>
          <section className="settings-section settings-grid">
            <label>
              本地粘贴响应
              <select value={preferences.pasteDelay} onChange={(event) => update('pasteDelay', Number(event.target.value))}>
                <option value="20">极速 · 20 ms</option>
                <option value="35">推荐 · 35 ms</option>
                <option value="60">稳妥 · 60 ms</option>
                <option value="100">兼容 · 100 ms</option>
              </select>
            </label>
            <label>
              远程同步等待
              <select value={preferences.remotePasteDelay} onChange={(event) => update('remotePasteDelay', Number(event.target.value))} disabled={!preferences.autoRemoteDelay}>
                <option value="200">快速 · 200 ms</option>
                <option value="320">推荐 · 320 ms</option>
                <option value="500">弱网 · 500 ms</option>
                <option value="800">高延迟 · 800 ms</option>
              </select>
            </label>
          </section>
        </div>
        <div className="dialog-actions dialog-actions--split">
          <button type="button" className="button button--danger" onClick={onQuit}>退出应用</button>
          <div className="save-actions">
            {saveError && <span className="settings-error" role="alert">{saveError}</span>}
            <button type="submit" className="button button--primary" disabled={saving}>{saving ? '保存中…' : '保存设置'}</button>
          </div>
        </div>
      </form>
    </div>
  );
}

export function App() {
  const { api, entries, setEntries, shortcut, setShortcut, screenshotShortcuts, setScreenshotShortcuts, preferences, setPreferences, notice, setNotice } = useClipboardState();
  const [tab, setTab] = useState('recent');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const searchRef = useRef(null);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    return entries.filter((entry) => {
      if (tab === 'pinned' && !entry.pinned) return false;
      if (tab === 'image' && entry.type !== 'image') return false;
      if (!normalized) return true;
      return `${entry.title || ''} ${entry.content || ''} ${(entry.files || []).join(' ')} ${entry.source?.app || ''} ${entry.source?.title || ''}`.toLocaleLowerCase('zh-CN').includes(normalized);
    });
  }, [entries, query, tab]);

  useEffect(() => setSelected(0), [query, tab]);
  useEffect(() => {
    if (!api) return undefined;
    return api.onFocusSearch(() => {
      setTimeout(() => searchRef.current?.focus(), 40);
    });
  }, [api]);

  const activeEntry = filtered[Math.min(selected, Math.max(0, filtered.length - 1))];

  async function paste(entry = activeEntry) {
    if (!entry) return;
    if (api) {
      const result = await api.pasteEntry(entry.id);
      if (!result.success) setNotice(result.message);
    } else {
      if (entry.type === 'image') setNotice('桌面版会把图片直接粘贴到当前应用');
      else {
        await navigator.clipboard?.writeText(entry.content || '');
        setNotice('已复制；桌面版会自动粘贴');
      }
    }
  }

  async function togglePin(entry) {
    if (!entry) return;
    if (api) await api.togglePin(entry.id);
    else setEntries((current) => current.map((item) => item.id === entry.id ? { ...item, pinned: !item.pinned } : item));
  }

  async function remove(entry) {
    if (!entry) return;
    if (api) await api.deleteEntry(entry.id);
    else setEntries((current) => current.filter((item) => item.id !== entry.id));
  }

  async function createEntry(payload) {
    if (api) {
      const result = await api.createEntry(payload);
      if (!result.success) { setNotice(result.message); return; }
    } else {
      const content = payload.type === 'image' ? '1920 × 1080 · PNG' : payload.content;
      setEntries((current) => [{
        id: `local-${Date.now()}`,
        type: payload.type,
        title: payload.title || content.split('\n')[0],
        content,
        imageUrl: payload.type === 'image' ? '/assets/sample-mountain.png' : undefined,
        createdAt: Date.now(),
        pinned: true,
        custom: true,
      }, ...current]);
    }
    setAddOpen(false);
    setTab('pinned');
    setNotice('已保存到常用');
  }

  async function saveSettings(nextShortcut, nextScreenshotShortcuts, nextPreferences) {
    if (api) {
      const result = await api.updateAllShortcuts(nextShortcut, nextScreenshotShortcuts);
      if (!result.success) { setNotice(result.message); return result; }
      const next = await api.updatePreferences(nextPreferences);
      setPreferences({ ...defaultPreferences, ...(next.preferences || {}) });
    }
    setShortcut(nextShortcut);
    setScreenshotShortcuts(nextScreenshotShortcuts);
    if (!api) setPreferences(nextPreferences);
    setSettingsOpen(false);
    setNotice('复制记录设置已保存');
    return { success: true };
  }

  function handleKeys(event) {
    if (addOpen || settingsOpen) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((current) => Math.min(current + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((current) => Math.max(0, current - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      paste();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      togglePin(activeEntry);
    } else if ((event.ctrlKey || event.metaKey) && event.key === ',') {
      event.preventDefault();
      setSettingsOpen(true);
    } else if (event.key === 'Escape') {
      api?.hideWindow();
    }
  }

  useEffect(() => {
    window.addEventListener('keydown', handleKeys);
    return () => window.removeEventListener('keydown', handleKeys);
  });

  return (
    <main className="app-stage">
      <section className="clipboard-shell" aria-label="Pasty 剪贴板">
        <header className="topbar">
          <div className="search-wrap">
            <Search24Regular aria-hidden="true" />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索剪贴板或常用内容" aria-label="搜索剪贴板" autoFocus />
            <kbd>Ctrl K</kbd>
          </div>
          <div className="topbar-actions">
            <button className="add-button" onClick={() => setAddOpen(true)} title="添加常用内容"><Add20Regular /><span>添加</span></button>
            <button type="button" className="icon-button window-close-button" onClick={() => api?.hideWindow()} aria-label="关闭主窗口" title="关闭窗口 · Esc"><Dismiss20Regular /></button>
          </div>
        </header>

        <nav className="tabs" aria-label="剪贴板分类">
          {tabs.map((item) => (
            <button key={item.id} className={tab === item.id ? 'tab is-active' : 'tab'} onClick={() => setTab(item.id)}>{item.label}</button>
          ))}
        </nav>

        <div className="list-heading">
          <span>{tab === 'recent' ? '最近复制' : tab === 'pinned' ? '我的常用' : '图片记录'}</span>
          <span>{filtered.length} 项</span>
        </div>

        <div className="entry-list" role="listbox" aria-label="剪贴板内容">
          {filtered.map((entry, index) => {
            const isSelected = index === selected;
            return (
              <article
                key={entry.id}
                className={isSelected ? 'entry-row is-selected' : 'entry-row'}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setSelected(index)}
                onDoubleClick={() => paste(entry)}
              >
                {entry.type === 'image' && entry.imageUrl ? (
                  <img className="entry-thumbnail" src={entry.imageUrl} alt="剪贴板图片预览" />
                ) : <EntryIcon type={entry.type} />}
                <button className="entry-content" onClick={() => { setSelected(index); paste(entry); }}>
                  <strong>{entry.title || entry.content}</strong>
                  <span className="entry-meta">
                    <span>{typeMeta[entry.type]?.label || '文本'}</span>
                    <span className="meta-dot" />
                    <span>{relativeTime(entry.createdAt)}</span>
                    {entry.type === 'image' && <><span className="meta-dot" /><span>{entry.content}</span></>}
                    {entry.source?.app && <><span className="meta-dot" /><span title={entry.source.title || ''}>来自 {entry.source.app}</span></>}
                    {entry.copyCount > 1 && <><span className="meta-dot" /><span>复制 {entry.copyCount} 次</span></>}
                  </span>
                </button>
                <div className="entry-actions">
                  <button className={entry.pinned ? 'icon-button pin is-pinned' : 'icon-button pin'} onClick={() => togglePin(entry)} aria-label={entry.pinned ? '取消固定' : '固定'} title={entry.pinned ? '取消固定' : '固定'}>
                    {entry.pinned ? <Pin20Filled /> : <Pin20Regular />}
                  </button>
                  <button className="icon-button delete" onClick={() => remove(entry)} aria-label="删除" title="删除"><Delete20Regular /></button>
                </div>
              </article>
            );
          })}

          {!filtered.length && (
            <div className="empty-state">
              <Search24Regular />
              <strong>{query ? '没有找到匹配内容' : '这里还是空的'}</strong>
              <span>{query ? '换一个关键词试试' : '复制文本、图片或文件后，它会自动出现在这里'}</span>
            </div>
          )}
        </div>

        <footer className="footer-bar">
          <div className="key-help"><kbd>↑</kbd><kbd>↓</kbd><span>选择</span></div>
          <div className="key-help"><kbd>Enter</kbd><span>粘贴</span></div>
          <div className="key-help"><kbd>Ctrl P</kbd><span>固定</span></div>
          <button className="settings-button settings-button--labeled" onClick={() => setSettingsOpen(true)} title={`快捷键与设置 · ${shortcut}`}><Settings20Regular /><span>快捷键</span></button>
        </footer>
      </section>

      {notice && <div className="toast" role="status">{notice}</div>}
      {addOpen && <AddDialog onClose={() => setAddOpen(false)} onSubmit={createEntry} />}
      {settingsOpen && <SettingsDialog initialShortcut={shortcut} initialScreenshotShortcuts={screenshotShortcuts} initialPreferences={preferences} onClose={() => setSettingsOpen(false)} onSave={saveSettings} onQuit={() => api?.quitApp()} />}
    </main>
  );
}
