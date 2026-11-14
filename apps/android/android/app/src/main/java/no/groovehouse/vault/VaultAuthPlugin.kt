package no.groovehouse.vault

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Del 12: Vault-adressen og enhetstokenet, kryptert med en AES-nøkkel i Android Keystore
 * (nøkkelen kan ikke hentes ut av telefonen). Aldri i vanlig localStorage, aldri i koden.
 */
@CapacitorPlugin(name = "VaultAuth")
class VaultAuthPlugin : Plugin() {
    private val prefs get() = context.getSharedPreferences("gv_auth", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    @PluginMethod
    fun load(call: PluginCall) {
        val blob = prefs.getString("blob", null)
        if (blob == null) {
            call.resolve(JSObject().put("server", JSONObject.NULL).put("token", JSONObject.NULL))
            return
        }
        try {
            val raw = Base64.decode(blob, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12))
            val j = JSONObject(String(cipher.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8))
            call.resolve(JSObject().put("server", j.optString("server")).put("token", j.optString("token")))
        } catch (e: Exception) {
            // Ødelagt eller nøkkel borte (f.eks. etter gjenoppretting): koble til på nytt
            prefs.edit().remove("blob").apply()
            call.resolve(JSObject().put("server", JSONObject.NULL).put("token", JSONObject.NULL))
        }
    }

    @PluginMethod
    fun save(call: PluginCall) {
        val server = call.getString("server")
        val token = call.getString("token")
        if (server.isNullOrBlank() || token.isNullOrBlank() || !server.startsWith("https://")) {
            call.reject("Ugyldig adresse eller token (bare HTTPS)")
            return
        }
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val enc = cipher.doFinal(JSONObject().put("server", server).put("token", token).toString().toByteArray(Charsets.UTF_8))
            prefs.edit().putString("blob", Base64.encodeToString(cipher.iv + enc, Base64.NO_WRAP)).apply()
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: e.toString())
        }
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        prefs.edit().remove("blob").apply()
        call.resolve()
    }

    companion object {
        private const val ALIAS = "gv_vault_auth"
    }
}
