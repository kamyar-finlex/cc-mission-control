// The page's entry point: loads every module in the order the old single script ran them, then connects.
import './core.js';
import './util.js';
import './board.js';
import './deploy.js';
import './updates.js';
import './editor.js';
import './why.js';
import './story.js';
import './usage.js';
import './live.js';
import './drawer.js';
import './markdown.js';
import './avatar.js';
import './menu.js';
import './newagent.js';
import './keys.js';
import { connect } from './live.js';

connect();
