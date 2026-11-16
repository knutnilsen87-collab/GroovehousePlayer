package no.groovehouse.vault

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Del 19: skinnet styrer statuslinje, navigasjonslinje og oppstartsskjerm.
 * Fargen settes med en gang; valget huskes så neste oppstart starter i riktig bakgrunn.
 */
@CapacitorPlugin(name = "SystemBars")
class SystemBarsPlugin : Plugin() {
    @PluginMethod
    fun set(call: PluginCall) {
        val bg = call.getString("background") ?: "#07080B"
        val splash = call.getString("splash") ?: "obsidian"
        val color = try { Color.parseColor(bg) } catch (e: IllegalArgumentException) { return call.reject("ugyldig farge") }
        prefs(context).edit().putInt(KEY_BG, color).putString(KEY_SPLASH, splash).apply()
        activity.runOnUiThread {
            apply(activity, color)
            call.resolve()
        }
    }

    companion object {
        private const val PREFS = "gv_skin"
        private const val KEY_BG = "background"
        private const val KEY_SPLASH = "splash"
        private const val OBSIDIAN = 0xFF07080B.toInt()

        private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        @Suppress("DEPRECATION")
        fun apply(a: Activity, color: Int) {
            a.window.statusBarColor = color
            a.window.navigationBarColor = color
            a.window.setBackgroundDrawable(ColorDrawable(color))
        }

        /** Kalles fra MainActivity før broen starter. */
        fun restore(a: Activity) {
            val p = prefs(a)
            apply(a, p.getInt(KEY_BG, OBSIDIAN))
            if (Build.VERSION.SDK_INT >= 33) {
                val theme = when (p.getString(KEY_SPLASH, "obsidian")) {
                    "oled" -> R.style.AppTheme_NoActionBarLaunch_Oled
                    "night" -> R.style.AppTheme_NoActionBarLaunch_Night
                    else -> R.style.AppTheme_NoActionBarLaunch
                }
                a.splashScreen.setSplashScreenTheme(theme)
            }
        }
    }
}
