import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CheckmarkCircle20Filled, Code20Regular, Document20Regular, Globe20Regular, Image20Regular, TextDescription20Regular } from '@fluentui/react-icons';
import './capture.css';

const icons = {
  text: TextDescription20Regular,
  code: Code20Regular,
  url: Globe20Regular,
  image: Image20Regular,
  file: Document20Regular,
};

function CaptureToast() {
  const [entry, setEntry] = useState(null);

  useEffect(() => window.clipboardAPI?.onCaptureShow(setEntry), []);
  if (!entry) return null;
  const Icon = icons[entry.type] || TextDescription20Regular;
  const detail = [entry.source?.app && `来自 ${entry.source.app}`, entry.copyCount > 1 && `第 ${entry.copyCount} 次复制`].filter(Boolean).join(' · ') || '已写入本地历史';

  return (
    <main className="capture-card" key={`${entry.id}-${entry.copyCount}`}>
      <span className={`capture-icon capture-icon--${entry.type}`}><Icon /></span>
      <span className="capture-copy">
        <span className="capture-status"><CheckmarkCircle20Filled /> 已保存</span>
        <strong>{entry.title || entry.content}</strong>
        <small>{detail}</small>
      </span>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<CaptureToast />);
