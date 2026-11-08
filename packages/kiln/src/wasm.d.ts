/** Bun's file loader returns a disk path in source and an embedded path after compilation. */
declare module "quickjs-wasi/quickjs.wasm" {
  const path: string;
  export default path;
}
