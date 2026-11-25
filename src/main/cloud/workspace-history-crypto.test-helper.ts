import {createCipheriv,createDecipheriv,randomBytes} from "node:crypto";
import {createTeamHistoryCipher,type TeamHistoryCipher} from "./workspace-history-crypto";

/** Test-only OS storage stand-in, using an ephemeral AES-256-GCM key.
 * The key is never saved to disk or shipped with a production build. */
const key=randomBytes(32);
export const testHistoryCipher:TeamHistoryCipher=createTeamHistoryCipher({
  isEncryptionAvailable:()=>true,
  encryptString(plaintext:string):Buffer{
    const iv=randomBytes(12);
    const cipher=createCipheriv("aes-256-gcm",key,iv);
    return Buffer.concat([iv,cipher.update(plaintext,"utf8"),cipher.final(),cipher.getAuthTag()]);
  },
  decryptString(payload:Buffer):string{
    if(payload.length<29)throw Error("Invalid test encryption payload");
    const decipher=createDecipheriv("aes-256-gcm",key,payload.subarray(0,12));
    decipher.setAuthTag(payload.subarray(payload.length-16));
    return Buffer.concat([decipher.update(payload.subarray(12,-16)),decipher.final()]).toString("utf8");
  },
});
