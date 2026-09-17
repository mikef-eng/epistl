// Manual mock for `@expo/vector-icons`, auto-applied by Jest (it lives in
// `__mocks__/` adjacent to `node_modules`, which Jest picks up for
// node_modules packages with no `jest.mock()` call needed in test files).
//
// The real package's icon components asynchronously load their font via
// `expo-font`, which under Jest tries to resolve a baked-in numeric asset
// reference from `@expo/vector-icons`'s pre-built output against the
// asset registry -- that registry entry only exists inside a real Metro
// bundle, so under Jest it throws `Module "N" is missing from the asset
// registry` from every screen's `componentDidMount`. Tests here only need
// an icon to render as *something* without crashing, not a real glyph, so
// every icon set is stubbed as a plain `View`.
const React = require('react');
const { View } = require('react-native');

function createIconStub(iconSetName) {
  function IconStub(props) {
    return React.createElement(View, { ...props, testID: props.testID ?? `icon-${iconSetName}` });
  }
  IconStub.displayName = iconSetName;
  return IconStub;
}

module.exports = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === '__esModule') {
        return true;
      }
      return createIconStub(String(prop));
    },
  }
);
