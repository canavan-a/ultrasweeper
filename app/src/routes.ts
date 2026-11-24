// Hand-rolled routing, same approach as super-badger's app: no
// react-navigation (native-only deps for two screens is overkill), App.tsx
// just switches on this union.
export type Route = {name: 'scan'} | {name: 'settings'} | {name: 'logs'} | {name: 'map'};
