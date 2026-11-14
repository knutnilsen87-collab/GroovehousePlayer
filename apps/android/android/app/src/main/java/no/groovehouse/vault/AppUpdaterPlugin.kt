package no.groovehouse.vault

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.zip.ZipInputStream

/**
 * Del 15: oppdatering av appen uten å installere APK-er for hånd.
 *
 * Web-bunt: lastes ned fra Vault (samme tilgang som resten: Tailscale + enhetstoken), sjekkes mot
 * sha256, pakkes ut i filesDir/bundles/<versjon>/ og tas i bruk ved NESTE oppstart via Capacitors
 * egen «serverBasePath» (som nullstilles automatisk når en ny APK installeres). Den nye bunten må
 * melde «klar» innen 10 s, ellers rulles det tilbake til forrige bunt (eller den innebygde).
 * Settes aldri i spill mens musikken spiller (da venter vi til neste gang).
 *
 * APK: lastes ned til cache, sjekkes mot sha256, og Androids installasjonsdialog åpnes.
 */
@CapacitorPlugin(name = "AppUpdater")
class AppUpdaterPlugin : Plugin() {
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    private val prefs get() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val capPrefs get() = context.getSharedPreferences(CAP_PREFS, Context.MODE_PRIVATE)
    private val bundlesDir get() = File(context.filesDir, "bundles")

    override fun load() {
        val p = prefs
        val trial = p.getLong(KEY_TRIAL, 0L)
        val capPath = capPrefs.getString(CAP_PATH, "") ?: ""
        if (trial > 0 && capPath.isNotEmpty()) {
            if (p.getBoolean(KEY_TRIAL_LAUNCHED, false)) {
                // Forrige oppstart med den nye bunten ble aldri «klar» (krasj eller drept): rull tilbake nå.
                rollback("bunt $trial meldte aldri klar")
                return
            }
            p.edit().putBoolean(KEY_TRIAL_LAUNCHED, true).apply()
            main.postDelayed({
                if (prefs.getLong(KEY_TRIAL, 0L) == trial) rollback("bunt $trial meldte ikke klar innen 10 s")
            }, 10_000)
        }
    }

    private fun rollback(reason: String) {
        val p = prefs
        val bad = p.getLong(KEY_TRIAL, 0L)
        val previous = p.getString(KEY_PREVIOUS_PATH, "") ?: ""
        val usable = previous.isNotEmpty() && File(previous, "index.html").exists()
        capPrefs.edit().putString(CAP_PATH, if (usable) previous else "").apply()
        p.edit()
            .putLong(KEY_TRIAL, 0L)
            .putBoolean(KEY_TRIAL_LAUNCHED, false)
            .putLong(KEY_BAD, bad)
            .putString(KEY_LAST_ERROR, reason)
            .putLong(KEY_ACTIVE, if (usable) p.getLong(KEY_PREVIOUS, 0L) else 0L)
            .apply()
        main.post {
            if (usable) bridge.setServerBasePath(previous) else bridge.setServerAssetPath("public")
        }
    }

    /** Appen er oppe med den nye bunten: behold den. */
    @PluginMethod
    fun notifyReady(call: PluginCall) {
        val p = prefs
        val trial = p.getLong(KEY_TRIAL, 0L)
        if (trial > 0) {
            p.edit()
                .putLong(KEY_TRIAL, 0L)
                .putBoolean(KEY_TRIAL_LAUNCHED, false)
                .putLong(KEY_ACTIVE, trial)
                .apply()
            cleanup(keep = setOf(trial.toString(), p.getLong(KEY_PREVIOUS, 0L).toString()))
        }
        call.resolve()
    }

    @PluginMethod
    fun getInfo(call: PluginCall) {
        val pkg = context.packageManager.getPackageInfo(context.packageName, 0)
        val code = if (Build.VERSION.SDK_INT >= 28) pkg.longVersionCode else @Suppress("DEPRECATION") pkg.versionCode.toLong()
        val p = prefs
        call.resolve(
            JSObject()
                .put("versionCode", code)
                .put("versionName", pkg.versionName)
                .put("activeBundle", p.getLong(KEY_ACTIVE, 0L))
                .put("pendingBundle", p.getLong(KEY_PENDING, 0L))
                .put("badBundle", p.getLong(KEY_BAD, 0L))
                .put("lastError", p.getString(KEY_LAST_ERROR, null))
                .put("canInstall", if (Build.VERSION.SDK_INT >= 26) context.packageManager.canRequestPackageInstalls() else true)
        )
    }

    /**
     * Last ned og pakk ut en bunt. Tas i bruk ved neste oppstart (stage), og bare hvis det ikke spilles nå;
     * ellers ligger den klar og settes på ved neste kall (JS prøver igjen når musikken er pauset).
     */
    @PluginMethod
    fun downloadBundle(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url mangler")
        val version = (call.getDouble("version") ?: 0.0).toLong()
        val sha = call.getString("sha256")?.lowercase() ?: return call.reject("sha256 mangler")
        val headers = call.getObject("headers")
        if (version <= 0) return call.reject("ugyldig versjon")
        if (version == prefs.getLong(KEY_BAD, 0L)) return call.reject("bunt $version er markert som ødelagt")
        io.execute {
            try {
                val dir = File(bundlesDir, version.toString())
                if (!File(dir, "index.html").exists()) {
                    val zip = File(context.cacheDir, "bundle-$version.zip")
                    download(url, headers, zip)
                    val got = sha256(zip)
                    if (got != sha) {
                        zip.delete()
                        return@execute call.reject("sha256 stemmer ikke (fikk $got)")
                    }
                    val tmp = File(bundlesDir, "$version.partial")
                    tmp.deleteRecursively()
                    unzip(zip, tmp)
                    zip.delete()
                    if (!File(tmp, "index.html").exists()) {
                        tmp.deleteRecursively()
                        return@execute call.reject("bunten mangler index.html")
                    }
                    dir.deleteRecursively()
                    if (!tmp.renameTo(dir)) throw IllegalStateException("klarte ikke å flytte bunten på plass")
                }
                prefs.edit().putLong(KEY_PENDING, version).apply()
                main.post { call.resolve(JSObject().put("staged", stageIfIdle())) }
            } catch (e: Exception) {
                call.reject(e.message ?: e.toString())
            }
        }
    }

    /** Sett ventende bunt for neste oppstart hvis det ikke spilles. */
    @PluginMethod
    fun stage(call: PluginCall) = call.resolve(JSObject().put("staged", stageIfIdle()))

    private fun stageIfIdle(): Boolean {
        val p = prefs
        val pending = p.getLong(KEY_PENDING, 0L)
        if (pending <= 0) return false
        if (Queue.player?.isPlaying == true) return false // aldri bytt mens musikk spilles
        val dir = File(bundlesDir, pending.toString())
        if (!File(dir, "index.html").exists()) return false
        val current = capPrefs.getString(CAP_PATH, "") ?: ""
        p.edit()
            .putString(KEY_PREVIOUS_PATH, current)
            .putLong(KEY_PREVIOUS, p.getLong(KEY_ACTIVE, 0L))
            .putLong(KEY_TRIAL, pending)
            .putBoolean(KEY_TRIAL_LAUNCHED, false)
            .putLong(KEY_PENDING, 0L)
            .apply()
        capPrefs.edit().putString(CAP_PATH, dir.absolutePath).apply()
        return true
    }

    /** Last ned APK-en til cache og sjekk sha256. */
    @PluginMethod
    fun downloadApk(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url mangler")
        val sha = call.getString("sha256")?.lowercase() ?: return call.reject("sha256 mangler")
        val headers = call.getObject("headers")
        io.execute {
            try {
                val dir = File(context.cacheDir, "apk").apply { mkdirs() }
                dir.listFiles()?.forEach { it.delete() }
                val apk = File(dir, "groovehouse-vault-update.apk")
                download(url, headers, apk)
                val got = sha256(apk)
                if (got != sha) {
                    apk.delete()
                    return@execute call.reject("sha256 stemmer ikke (fikk $got)")
                }
                call.resolve(JSObject().put("ok", true))
            } catch (e: Exception) {
                call.reject(e.message ?: e.toString())
            }
        }
    }

    /** Åpne Androids installasjonsdialog. Første gang: innstillingen «Installer ukjente apper» for appen. */
    @PluginMethod
    fun installApk(call: PluginCall) {
        val apk = File(File(context.cacheDir, "apk"), "groovehouse-vault-update.apk")
        if (!apk.exists()) return call.reject("ingen nedlastet APK")
        if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls()) {
            val i = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(i)
            return call.resolve(JSObject().put("needsPermission", true))
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
        val i = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(i)
        call.resolve(JSObject().put("needsPermission", false))
    }

    // ---------------------------------------------------------------- hjelpere

    private fun download(url: String, headers: JSObject?, out: File) {
        val u = URL(url)
        if (u.protocol != "https") throw IllegalArgumentException("bare HTTPS")
        val c = u.openConnection() as HttpURLConnection
        c.connectTimeout = 15_000
        c.readTimeout = 60_000
        headers?.keys()?.forEach { k -> c.setRequestProperty(k, headers.getString(k)) }
        try {
            if (c.responseCode != 200) throw IllegalStateException("HTTP ${c.responseCode}")
            c.inputStream.use { inp -> FileOutputStream(out).use { inp.copyTo(it, 64 * 1024) } }
        } finally {
            c.disconnect()
        }
    }

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { inp ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = inp.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** Pakker ut med vern mot «zip slip» (stier utenfor målmappa avvises). */
    private fun unzip(zip: File, dest: File) {
        dest.mkdirs()
        val root = dest.canonicalPath + File.separator
        ZipInputStream(zip.inputStream().buffered()).use { z ->
            while (true) {
                val e = z.nextEntry ?: break
                val f = File(dest, e.name)
                if (!f.canonicalPath.startsWith(root)) throw SecurityException("ugyldig sti i bunten: ${e.name}")
                if (e.isDirectory) f.mkdirs() else {
                    f.parentFile?.mkdirs()
                    FileOutputStream(f).use { z.copyTo(it) }
                }
            }
        }
    }

    private fun cleanup(keep: Set<String>) {
        bundlesDir.listFiles()?.forEach { if (it.name !in keep) it.deleteRecursively() }
    }

    companion object {
        const val PREFS = "gv_updater"
        const val CAP_PREFS = "CapWebViewSettings"
        const val CAP_PATH = "serverBasePath"
        const val KEY_ACTIVE = "active"
        const val KEY_PENDING = "pending"
        const val KEY_TRIAL = "trial"
        const val KEY_TRIAL_LAUNCHED = "trialLaunched"
        const val KEY_PREVIOUS = "previous"
        const val KEY_PREVIOUS_PATH = "previousPath"
        const val KEY_BAD = "bad"
        const val KEY_LAST_ERROR = "lastError"
    }
}
