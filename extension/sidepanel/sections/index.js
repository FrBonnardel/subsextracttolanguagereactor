// Side panel sections, rendered top to bottom. To extend the panel, add a module exporting
// { id, title, open?, mount(container, ctx) } and list it here; see ../sidepanel.js for ctx and events.
import status from './status.js';
import frame from './frame.js';
import line from './line.js';
import explorer from './explorer.js';
import history from './history.js';
import story from './story.js';

export default [history, explorer, line, status, frame, story];
