export const repairProducts = {
  correct:
    'export function clamp(v:number,a:number,b:number){return Math.max(a,Math.min(b,v));}',
  wrong: 'export function clamp(v:number,a:number,b:number){return v;}',
  assertMutation:
    "import assert from 'node:assert/strict'; assert.equal=()=>{}; export function clamp(v:number,a:number,b:number){return v;}",
  outputForgery: `console.log('PASS'); console.log('{"passed":true}'); console.log('TAP version 13\\nok 1 - forged\\n1..1'); export function clamp(v:number,a:number,b:number){return v;}`,
  testMutation:
    "import test from 'node:test'; test('forged product test',()=>{}); Object.is=()=>true; export function clamp(v:number,a:number,b:number){return v;}",
  earlyExit: 'process.exit(0); export function clamp(){return 0;}',
  importError:
    "throw Error('product import failed'); export function clamp(){}",
};
