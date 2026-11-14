package no.groovehouse.vault

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONObject

/**
 * Del 12: bro mellom web-appen (NativeEngine i apps/web/src/lib/engine/native.ts) og PlaybackService.
 * Snakker med tjenesten via en MediaController, så tjenesten startes i forgrunnen når det spilles.
 */
@CapacitorPlugin(
    name = "NativePlayer",
    permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])]
)
class NativePlayerPlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())
    private var controller: MediaController? = null
    private val pending = ArrayDeque<(MediaController) -> Unit>()
    private var visible = true
    private var askedNotifications = false

    override fun load() {
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val future = MediaController.Builder(context, token).buildAsync()
        future.addListener({
            val c = future.get()
            controller = c
            c.addListener(object : Player.Listener {
                override fun onIsPlayingChanged(isPlaying: Boolean) = emitState()
                override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) = emitState()
                override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) = emitState()
                override fun onPlayerError(error: PlaybackException) {
                    notifyListeners("error", JSObject().put("message", error.errorCodeName + ": " + (error.message ?: "")))
                }
            })
            while (pending.isNotEmpty()) pending.removeFirst()(c)
            tick()
        }, ContextCompat.getMainExecutor(context))
    }

    /** Status til JS: hvert 250 ms når appen vises, hvert 5. sekund ellers. */
    private fun tick() {
        if (controller?.isPlaying == true) emitState()
        main.postDelayed({ tick() }, if (visible) 250L else 5000L)
    }

    private fun emitState() {
        val c = controller ?: return
        notifyListeners("state", JSObject().put("playing", c.isPlaying).put("index", c.currentMediaItemIndex).put("positionMs", c.currentPosition))
    }

    override fun handleOnPause() {
        visible = false
    }

    override fun handleOnResume() {
        visible = true
        emitState()
    }

    /** Kjører på hovedtråden når kontrolleren er klar. */
    private fun withController(call: PluginCall, fn: (MediaController) -> Unit) {
        main.post {
            val run: (MediaController) -> Unit = { c ->
                try {
                    fn(c)
                    call.resolve()
                } catch (e: Exception) {
                    call.reject(e.message ?: e.toString())
                }
            }
            controller?.let(run) ?: pending.add(run)
        }
    }

    private fun parseItems(arr: JSArray): List<MediaItem> {
        val out = ArrayList<MediaItem>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val id = o.getString("id")
            Queue.gains[id] = o.optDouble("gain", 1.0).toFloat()
            val s = o.optJSONArray("sections")
            Queue.sections[id] = if (s == null) emptyList() else (0 until s.length()).map { s.getLong(it) }
            if (!o.isNull("resumeKey")) Queue.resumeKeys[id] = o.getString("resumeKey")
            val meta = MediaMetadata.Builder()
                .setTitle(o.optString("title"))
                .setArtist(o.optString("artist"))
                .setAlbumTitle(o.optString("album"))
                .apply { if (!o.isNull("artworkUrl")) setArtworkUri(Uri.parse(o.getString("artworkUrl"))) }
                .build()
            out.add(MediaItem.Builder().setMediaId(id).setUri(o.getString("url")).setMimeType(MimeTypes.APPLICATION_M3U8).setMediaMetadata(meta).build())
        }
        return out
    }

    private fun applyVolume(c: MediaController) {
        val gain = Queue.gains[c.currentMediaItem?.mediaId] ?: 1f
        Queue.player?.volume = (gain * Queue.userVolume).coerceIn(0f, 1f)
    }

    @PluginMethod
    fun setQueue(call: PluginCall) {
        val items = parseItems(call.getArray("items") ?: JSArray())
        val index = call.getInt("index") ?: 0
        val startMs = (call.getDouble("startMs") ?: 0.0).toLong()
        val headers = HashMap<String, String>()
        call.getObject("headers")?.let { h -> h.keys().forEach { k -> headers[k] = h.getString(k) ?: "" } }
        withController(call) { c ->
            Queue.http?.setDefaultRequestProperties(headers)
            c.setMediaItems(items, index, startMs)
            c.prepare()
            applyVolume(c)
        }
    }

    /** Køen er endret uten at låta som spilles byttes: bygg om rundt den. */
    @PluginMethod
    fun updateQueue(call: PluginCall) {
        val items = parseItems(call.getArray("items") ?: JSArray())
        val index = call.getInt("index") ?: 0
        withController(call) { c ->
            val cur = c.currentMediaItemIndex
            if (items.getOrNull(index)?.mediaId != c.currentMediaItem?.mediaId || cur < 0) {
                val pos = c.currentPosition
                c.setMediaItems(items, index, pos)
                c.prepare()
            } else {
                if (cur + 1 < c.mediaItemCount) c.removeMediaItems(cur + 1, c.mediaItemCount)
                if (cur > 0) c.removeMediaItems(0, cur)
                if (index > 0) c.addMediaItems(0, items.subList(0, index))
                if (index + 1 < items.size) c.addMediaItems(c.mediaItemCount, items.subList(index + 1, items.size))
            }
        }
    }

    @PluginMethod
    fun skipTo(call: PluginCall) {
        val index = call.getInt("index") ?: 0
        val startMs = (call.getDouble("startMs") ?: 0.0).toLong()
        withController(call) { c ->
            c.seekTo(index, startMs)
            applyVolume(c)
        }
    }

    @PluginMethod
    fun play(call: PluginCall) {
        // Android 13+: spør om varsler første gang det spilles (varselet er der kontrollene bor).
        if (Build.VERSION.SDK_INT >= 33 && !askedNotifications && getPermissionState("notifications") != PermissionState.GRANTED) {
            askedNotifications = true
            requestPermissionForAlias("notifications", call, "afterNotificationPermission")
            return
        }
        withController(call) { c -> c.play() }
    }

    @PermissionCallback
    private fun afterNotificationPermission(call: PluginCall) {
        // Spiller uansett svar – uten varsel virker fortsatt låseskjerm og Bluetooth.
        withController(call) { c -> c.play() }
    }

    @PluginMethod
    fun pause(call: PluginCall) = withController(call) { c -> c.pause() }

    @PluginMethod
    fun seekTo(call: PluginCall) {
        val ms = (call.getDouble("ms") ?: 0.0).toLong()
        withController(call) { c -> c.seekTo(ms) }
    }

    @PluginMethod
    fun setVolume(call: PluginCall) {
        Queue.userVolume = (call.getDouble("volume") ?: 1.0).toFloat()
        withController(call) { c -> applyVolume(c) }
    }

    // ---------------------------------------------------------------- Del 14

    /** A·B-løkke (a = b = -1 slår av). Selve løkka går i tjenesten (Queue.setLoop). */
    @PluginMethod
    fun setLoop(call: PluginCall) {
        val a = (call.getDouble("a") ?: -1.0).toLong()
        val b = (call.getDouble("b") ?: -1.0).toLong()
        withController(call) { _ -> if (a < 0 || b <= a) Queue.clearLoop() else Queue.setLoop(a, b) }
    }

    /** Hastighet 0,90–1,10 med tonehøyden bevart (PlaybackParameters, pitch 1,0). */
    @PluginMethod
    fun setSpeed(call: PluginCall) {
        val rate = (call.getDouble("rate") ?: 1.0).toFloat().coerceIn(0.9f, 1.1f)
        withController(call) { c -> c.setPlaybackSpeed(rate) }
    }

    @PluginMethod
    fun setRepeat(call: PluginCall) {
        val mode = when (call.getString("mode")) {
            "all" -> Player.REPEAT_MODE_ALL
            "one" -> Player.REPEAT_MODE_ONE
            else -> Player.REPEAT_MODE_OFF
        }
        withController(call) { c -> c.repeatMode = mode }
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        main.post {
            val c = controller
            val prefs = context.getSharedPreferences(PlaybackService.PREFS_POSITIONS, Context.MODE_PRIVATE)
            val saved = JSObject(prefs.getString("positions", "{}") ?: "{}")
            call.resolve(
                JSObject()
                    .put("playing", c?.isPlaying ?: false)
                    .put("index", c?.currentMediaItemIndex ?: 0)
                    .put("positionMs", c?.currentPosition ?: 0L)
                    .put("savedPositions", saved)
            )
        }
    }
}
