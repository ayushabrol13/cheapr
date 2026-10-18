// Build-time configuration. scripts/package.sh rewrites BACKEND for release builds (and adds its origin to
// manifest host_permissions); unpacked development builds talk to a local server.
globalThis.CHEAPR_CONFIG = {
  BACKEND: "http://localhost:8000",
  UNINSTALL_URL: "https://github.com/ayushabrol13/cheapr/issues/new?title=Uninstall%20feedback",
};
