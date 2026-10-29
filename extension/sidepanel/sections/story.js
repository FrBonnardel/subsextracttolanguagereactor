export default {
  id: 'story',
  title: 'Story context',
  open: false,
  mount(root, { bus, el }) {
    const status = el('div', 'muted', 'Waiting for the page...');
    const text = el('div', 'raw');
    root.append(status, text);
    let revision = 0;

    function render(data) {
      status.textContent = !data.enabled ? 'Story context is disabled for this translator.'
        : data.pending ? 'Loading story context...'
        : data.text ? 'Loaded context used for translation:'
        : 'No story context loaded yet.';
      text.textContent = data.text ?? '';
    }

    bus.on('story', (data) => {
      revision++;
      render(data);
    });
    bus.on('episode', () => {
      revision++;
      render({ enabled: true });
    });
    bus.on('tab', async (tab) => {
      const current = ++revision;
      text.textContent = '';
      status.textContent = 'Reading loaded context...';
      if (!tab?.id) {
        status.textContent = 'No active tab.';
        return;
      }
      try {
        const data = await chrome.tabs.sendMessage(tab.id, { type: 'HSR_GET_STORY_CONTEXT' });
        if (current !== revision) return;
        if (!data) throw new Error('No response from the page');
        render(data);
      } catch (e) {
        if (current !== revision) return;
        status.textContent = 'Context unavailable. Refresh a supported video page.';
        HSR_log('warn', 'sidepanel', 'Reading story context:', e);
      }
    });
  },
};
