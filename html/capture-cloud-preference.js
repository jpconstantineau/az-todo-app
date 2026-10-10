export const captureCloudPreferenceKey = 'todo-capture-cloud-ai';

export function parseCaptureCloudPreference(value) {
  if (value === null) return false;
  const parsed = JSON.parse(value);
  if (typeof parsed !== 'boolean') throw new Error('Invalid Capture cloud AI preference.');
  return parsed;
}

export function setupCaptureCloudPreference() {
  const control = document.getElementById('captureCloudAI');
  const status = document.getElementById('captureCloudPreferenceStatus');
  let enabled = false;

  const announce = message => { status.textContent = message; status.hidden = !message; };
  const notify = () => document.dispatchEvent(new CustomEvent('capturecloudpreferencechange', { detail: { enabled } }));
  const read = () => {
    try {
      enabled = parseCaptureCloudPreference(localStorage.getItem(captureCloudPreferenceKey));
      announce('');
    } catch {
      enabled = false;
      announce('Cloud AI for Capture is Off because this browser could not read a valid preference.');
    }
    control.checked = enabled;
    notify();
  };

  control.addEventListener('change', () => {
    const next = control.checked;
    try {
      localStorage.setItem(captureCloudPreferenceKey, JSON.stringify(next));
      enabled = next;
      announce(next ? 'Cloud AI for Capture is On in this browser. Nothing is sent until you press the Capture cloud button.' : 'Cloud AI for Capture is Off in this browser.');
    } catch {
      enabled = false;
      control.checked = false;
      announce('Cloud AI for Capture remains Off because this browser could not save the preference.');
    }
    notify();
  });
  addEventListener('storage', event => {
    if (event.key === captureCloudPreferenceKey || event.key === null) read();
  });
  read();
  return { get enabled() { return enabled; } };
}
