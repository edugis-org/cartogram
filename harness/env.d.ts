declare module 'go-cart-wasm' {
  const initGoCart: (options?: { locateFile?: (path: string) => string }) => Promise<unknown>;
  export default initGoCart;
}
declare module '*.wasm?url' {
  const url: string;
  export default url;
}
