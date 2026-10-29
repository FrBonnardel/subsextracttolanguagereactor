export default {
  id: 'status',
  title: 'Status',
  open: false,
  mount(root, { bus, el }) {
    const host = el('div', 'muted');
    const state = el('div', null, 'Waiting for the page…');
    root.append(host, state);

    bus.on('tab', (tab) => {
      let name = '—';
      try { name = tab?.url ? new URL(tab.url).hostname || tab.url : '—'; } catch { /* non-URL */ }
      host.textContent = name;
      state.textContent = 'No events yet – play a video (refresh the tab if the extension was just reloaded).';
    });
    bus.on('state', ({ text }) => { state.textContent = `Capture: ${text}`; });
  },
};
