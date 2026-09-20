// The web app draws its own aurora (src/components/Aurora.tsx, WebGL, the same
// shader body). This file exists so that the Expo web export of the phone app
// resolves `./src/Aurora` to nothing at all rather than to the Skia layer: one
// import of @shopify/react-native-skia would pull CanvasKit's several megabytes
// of wasm into a bundle that has no use for it.
export default function Aurora() {
  return null
}
