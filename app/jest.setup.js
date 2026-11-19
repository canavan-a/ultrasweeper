/* global jest */
// AsyncStorage is a native module; under Jest it needs the official in-memory
// mock, or anything that imports src/settings.ts fails with "AsyncStorage is null".
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// Notifee (alerts, background service) is native too; it ships a Jest mock.
jest.mock('@notifee/react-native', () => require('@notifee/react-native/jest-mock'));
