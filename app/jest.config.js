module.exports = {
  preset: 'react-native',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // lucide-react-native's package "exports" points Jest at its ESM build, which
  // the react-native preset doesn't transform; use its CommonJS build instead.
  // @notifee/react-native's own Jest mock (jest.setup.js) is ESM, so it has
  // to go through Babel like react-native itself; this is the preset's
  // default pattern plus @notifee.
  transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native(-community)?|@notifee)/)'],
  moduleNameMapper: {
    '^lucide-react-native$': '<rootDir>/node_modules/lucide-react-native/dist/cjs/lucide-react-native.js',
  },
};
