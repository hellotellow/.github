import { register } from 'node:module'

register('./module-hook.mjs', import.meta.url)
