/** OS-backed encryption for TEAM history payloads. This module has no
 * Electron runtime import so SQLite tests can inject an independent provider.
 * Never fall back to a bundled key, base64-only encoding or plaintext.
 */
export interface SafeHistoryStorage {
  isEncryptionAvailable():boolean;
  encryptString(text:string):Buffer;
  decryptString(payload:Buffer):string;
}
export interface TeamHistoryCipher {
  encrypt(plaintext:string):string;
  decrypt(ciphertext:string):string;
}
const PREFIX="sa1:";
const BASE64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export function createTeamHistoryCipher(storage:SafeHistoryStorage):TeamHistoryCipher{
  if(!storage.isEncryptionAvailable())
    throw Error("Team history protection requires OS encryption; local cache disabled");
  return {
    encrypt(plaintext:string):string{
      if(typeof plaintext!=="string")throw Error("Invalid team history plaintext");
      const encrypted=storage.encryptString(plaintext);
      if(!Buffer.isBuffer(encrypted)||encrypted.length<1)
        throw Error("OS encryption returned no protected bytes");
      return PREFIX+encrypted.toString("base64");
    },
    decrypt(ciphertext:string):string{
      if(typeof ciphertext!=="string"||!ciphertext.startsWith(PREFIX))
        throw Error("Unencrypted or unsupported team history record");
      const encoded=ciphertext.slice(PREFIX.length);
      if(encoded.length<4||encoded.length>12_000_000||!BASE64.test(encoded))
        throw Error("Malformed protected team history ciphertext");
      const data=Buffer.from(encoded,"base64");
      if(data.length===0||data.toString("base64")!==encoded)
        throw Error("Noncanonical protected team history ciphertext");
      const result=storage.decryptString(data);
      if(typeof result!=="string")throw Error("Invalid OS-decrypted team history");
      return result;
    },
  };
}
