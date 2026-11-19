/**
 * @format
 */

import {AppRegistry} from 'react-native';
import App from './src/App';
import {registerBackgroundRunner} from './src/background';
import {name as appName} from './app.json';

// Must run at bundle load, before a foreground service can start (see
// src/background.ts).
registerBackgroundRunner();
AppRegistry.registerComponent(appName, () => App);
