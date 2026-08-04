package com.rosary.andengyuanhua

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/** Agent 闹铃到点广播：发系统通知（备注为 AI 写的闹铃内容），不打开应用、不打扰流程。 */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val title = intent.getStringExtra("title")?.take(120) ?: "闹铃时间到"
        val triggerAt = intent.getLongExtra("triggerAt", 0L)
        val timeText = if (triggerAt > 0) {
            java.text.SimpleDateFormat("MM月dd日 HH:mm", java.util.Locale.getDefault())
                .format(java.util.Date(triggerAt))
        } else {
            "闹铃"
        }

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // Android 8+ 需要通知渠道
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(
                    "andy_alarm",
                    "闹铃提醒",
                    NotificationManager.IMPORTANCE_HIGH
                )
            )
        }
        val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.app.Notification.Builder(context, "andy_alarm")
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle(timeText)
                .setContentText(title)
                .setAutoCancel(true)
                .setPriority(android.app.Notification.PRIORITY_HIGH)
                .build()
        } else {
            @Suppress("DEPRECATION")
            android.app.Notification.Builder(context)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle(timeText)
                .setContentText(title)
                .setAutoCancel(true)
                .setPriority(android.app.Notification.PRIORITY_HIGH)
                .build()
        }
        try {
            nm.notify(triggerAt.toInt(), notification)
        } catch (_: Exception) {
            // 通知失败静默（如无通知权限）
        }
    }
}
