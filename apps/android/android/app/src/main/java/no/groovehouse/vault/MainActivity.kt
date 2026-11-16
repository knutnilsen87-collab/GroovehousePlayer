package no.groovehouse.vault

import android.os.Bundle
import com.getcapacitor.BridgeActivity

/** Groovehouse Vault: registrerer egne plugins (Media3-spilleren og Keystore-lageret) før broen startes. */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(NativePlayerPlugin::class.java)
        registerPlugin(VaultAuthPlugin::class.java)
        registerPlugin(AppUpdaterPlugin::class.java)
        registerPlugin(SystemBarsPlugin::class.java)
        super.onCreate(savedInstanceState)
        // Del 19: skinnets bakgrunn på statuslinje/navigasjonslinje (og oppstartsskjermen neste gang)
        SystemBarsPlugin.restore(this)
    }
}
