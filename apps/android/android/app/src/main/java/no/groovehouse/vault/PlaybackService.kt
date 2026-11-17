package no.groovehouse.vault

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.PlayerMessage
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject

/**
 * Del 12: tjenesten i forgrunnen som eier avspillingen (Media3). Køen ligger her, så neste låt
 * starter også når skjermen er av og JavaScript ikke kjører. Varsel med cover, låseskjerm,
 * Bluetooth-knapper og bil får kontrollene gratis via MediaSession; lydfokus (samtaler) og
 * «hodetelefoner dratt ut» håndteres av ExoPlayer.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private val main = Handler(Looper.getMainLooper())

    override fun onCreate() {
        super.onCreate()
        val http = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(false)
            .setUserAgent("GroovehouseVault/Android")
        Queue.http = http
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(http))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
                /* handleAudioFocus = */ true
            )
            .setHandleAudioBecomingNoisy(true)
            // Del 14: hold CPU og Wi-Fi våkne mens det strømmes (HLS over Tailscale med skjermen av)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        player.addListener(object : Player.Listener {
            override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
                applyVolume(player)
                savePosition(player)
                // A·B-løkka gjelder bare låta den ble satt i (gjenta én låt beholder den)
                if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT) Queue.clearLoop()
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (!isPlaying) savePosition(player)
            }
        })
        Queue.player = player

        val nextSection = CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD)
            .setDisplayName("Neste seksjon")
            .setSessionCommand(SessionCommand(ACTION_NEXT_SECTION, Bundle.EMPTY))
            .build()
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        session = MediaSession.Builder(this, player)
            .setSessionActivity(open)
            .setCallback(object : MediaSession.Callback {
                override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult =
                    MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                        .setAvailableSessionCommands(
                            MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                                .add(SessionCommand(ACTION_NEXT_SECTION, Bundle.EMPTY)).build()
                        )
                        .build()

                override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo, customCommand: SessionCommand, args: Bundle): ListenableFuture<SessionResult> {
                    if (customCommand.customAction == ACTION_NEXT_SECTION) nextSection(player)
                    return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                }
            })
            .setMediaButtonPreferences(ImmutableList.of(nextSection))
            .build()
        setMediaNotificationProvider(DefaultMediaNotificationProvider.Builder(this).build().apply { setSmallIcon(R.drawable.ic_stat_vault) })

        // Del 18 pkt. 9: «Neste: Echo out – 8 takter igjen» under tittelen i varselet de siste 30 s før mikspunktet.
        // Sjekkes hvert sekund mens det spilles; metadata byttes bare når teksten endres (uten avbrudd i lyden).
        main.post(object : Runnable {
            override fun run() {
                if (player.isPlaying) updateReminder(player)
                main.postDelayed(this, 1000)
            }
        })

        // Fortsett-posisjon (live-sett) lagres fra native-siden også, hvert 5. sekund mens det spilles.
        main.post(object : Runnable {
            override fun run() {
                if (player.isPlaying) savePosition(player)
                main.postDelayed(this, 5000)
            }
        })
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /** Appen sveipet bort fra «nylige»: fortsett hvis noe spilles, ellers stopp tjenesten. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = session?.player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        session?.run {
            player.release()
            release()
        }
        session = null
        Queue.player = null
        super.onDestroy()
    }

    private fun nextSection(player: Player) {
        val id = player.currentMediaItem?.mediaId ?: return
        val pos = player.currentPosition
        val next = Queue.sections[id]?.firstOrNull { it > pos + 500 } ?: return
        player.seekTo(next)
    }

    private var shownReminder: Pair<String, String?>? = null

    private fun updateReminder(player: Player) {
        val item = player.currentMediaItem ?: return
        val id = item.mediaId
        val text = Queue.reminders[id]?.textAt(player.currentPosition)
        val shown = shownReminder
        if (shown != null && shown.first == id && shown.second == text) return
        if (shown == null && text == null) return
        shownReminder = if (text == null) null else id to text
        val artist = text ?: Queue.artists[id] ?: ""
        if (item.mediaMetadata.artist?.toString() == artist) return
        val meta = item.mediaMetadata.buildUpon().setArtist(artist).build()
        player.replaceMediaItem(player.currentMediaItemIndex, item.buildUpon().setMediaMetadata(meta).build())
    }

    private fun applyVolume(player: Player) {
        val gain = Queue.gains[player.currentMediaItem?.mediaId] ?: 1f
        player.volume = (gain * Queue.userVolume).coerceIn(0f, 1f)
    }

    private fun savePosition(player: Player) {
        val key = Queue.resumeKeys[player.currentMediaItem?.mediaId] ?: return
        val prefs = getSharedPreferences(PREFS_POSITIONS, Context.MODE_PRIVATE)
        val all = JSONObject(prefs.getString("positions", "{}") ?: "{}")
        all.put(key, player.currentPosition)
        prefs.edit().putString("positions", all.toString()).apply()
    }

    companion object {
        const val ACTION_NEXT_SECTION = "gv.NEXT_SECTION"
        const val PREFS_POSITIONS = "gv_positions"
    }
}

/** Delt tilstand mellom tjenesten og pluginen (samme prosess). */
@OptIn(UnstableApi::class)
object Queue {
    var player: ExoPlayer? = null
    var http: DefaultHttpDataSource.Factory? = null
    val gains = HashMap<String, Float>()
    val sections = HashMap<String, List<Long>>()
    val resumeKeys = HashMap<String, String>()
    val artists = HashMap<String, String>()
    val reminders = HashMap<String, Reminder?>()
    var userVolume = 1f

    // ---------------------------------------------------------------- Del 14: A·B-løkke i tjenesten
    private var loopMessage: PlayerMessage? = null

    /**
     * Når avspillingen når B, hopp til A. Gjøres med en PlayerMessage på posisjon B i låta som spilles,
     * så den treffer presist og virker med skjermen av og JavaScript stoppet. Må kalles på hovedtråden.
     */
    fun setLoop(a: Long, b: Long) {
        clearLoop()
        val p = player ?: return
        if (a < 0 || b <= a) return
        val index = p.currentMediaItemIndex
        loopMessage = p.createMessage { _, _ -> p.seekTo(index, a) }
            .setLooper(Looper.getMainLooper())
            .setPosition(index, b)
            .setDeleteAfterDelivery(false)
            .send()
        if (p.currentPosition < a || p.currentPosition > b) p.seekTo(a)
    }

    fun clearLoop() {
        loopMessage?.cancel()
        loopMessage = null
    }
}

/**
 * Del 18 pkt. 9: påminnelse før mikspunktet ut av en låt. Samme regel som web (reminderBarsLeft i @gv/shared):
 * vises fra 30 s før mikspunktet til overgangen er ferdig, med takter igjen og steget som kommer.
 */
data class Reminder(val outAtMs: Long, val barMs: Double, val overlapBars: Int, val name: String, val steps: List<Pair<Long, String>>) {
    fun textAt(positionMs: Long): String? {
        val left = outAtMs - positionMs
        if (left > 30_000) return null
        if (left < -maxOf(1, overlapBars) * barMs) return null
        val bars = maxOf(0, kotlin.math.ceil(left / barMs).toInt())
        val step = steps.firstOrNull { it.first >= positionMs } ?: steps.lastOrNull()
        val head = "Neste: $name – " + if (bars > 0) "$bars takter igjen" else "nå"
        return if (step != null) "$head · ${step.second}" else head
    }
}