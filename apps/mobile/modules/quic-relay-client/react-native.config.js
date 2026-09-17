/**
 * @type {import('@react-native-community/cli-types').UserDependencyConfig}
 */
module.exports = {
  dependency: {
    platforms: {
      android: {
        cmakeListsPath: 'build/generated/source/codegen/jni/CMakeLists.txt',
        cxxModuleCMakeListsModuleName: 'quic-relay-client',
        cxxModuleCMakeListsPath: 'CMakeLists.txt',
      },
    },
  },
};
