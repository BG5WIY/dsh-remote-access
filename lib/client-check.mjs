// 可执行自检：node lib/client-check.mjs
//
// 不启动浏览器，只验证客户端 bundle 的注册协议与设置页入口：
//   1. ModuleLoader 注册 id 与包名一致；
//   2. apply 会向 settings.section 注册一个分区；
//   3. 分区渲染函数在没有宿主数据时也能安全返回元素。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('./client.js', import.meta.url)), 'utf8')

let captured
const window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
}

function element(type, props, ...children) {
  if (typeof type === 'function') return type(Object.assign({}, props, { children }))
  return { type, props: Object.assign({}, props, { children }) }
}

const React = {
  createElement: element,
  useEffect() {},
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
}

// bundle 以 IIFE 形式执行；`window` 由外层注入，`require` 由 factory 接收。
new Function('window', source)(window)

assert.ok(captured !== undefined, 'bundle must call __ModuleLoader__.load')
assert.equal(captured.id, 'dsh-remote-access', 'bundle id must equal the package name')

const exports = captured.factory((specifier) => {
  assert.equal(specifier, 'react')
  return React
})
assert.equal(typeof exports.apply, 'function')

let injected
let registered
const slots = {
  inject(name, callback) {
    injected = name
    callback()
  },
  register(definition, render) {
    registered = { definition, render }
    return () => {}
  },
}
exports.apply({ get: (name) => (name === 'slots' ? slots : undefined) })

assert.equal(injected, 'settings.section')
assert.equal(registered.definition.id, 'remote-web-access')
assert.equal(registered.definition.label, '外网访问')
const tree = registered.render()
assert.equal(typeof tree, 'object')
assert.equal(tree.type, 'div')

console.log('client-check: all assertions passed')
