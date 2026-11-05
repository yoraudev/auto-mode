import { createRuntime } from "../shared/runtime.js"
import { createExtension } from "./extension.js"

export default createExtension(createRuntime())
