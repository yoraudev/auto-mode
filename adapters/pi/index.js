import { createClient } from "../shared/client.js"
import { createExtension } from "./extension.js"

export default createExtension(createClient({ port: process.env.AUTO_MODE_PORT ? Number(process.env.AUTO_MODE_PORT) : undefined }))
