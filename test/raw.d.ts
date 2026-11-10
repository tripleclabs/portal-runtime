declare module "*.html?raw" {
  const html: string;
  export default html;
}

declare module "*.json?raw" { const source: string; export default source; }
