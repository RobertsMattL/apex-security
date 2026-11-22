package com.tactical.seccam

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.disk.DiskCache
import com.tactical.seccam.data.Repository

class SecCamApp : Application(), ImageLoaderFactory {
    lateinit var repo: Repository
        private set

    override fun onCreate() {
        super.onCreate()
        repo = Repository(this)
        repo.startIfSignedIn()
    }

    /** Coil shares the API's OkHttp client; event images use signed URLs, snapshots add a bearer header per request. */
    override fun newImageLoader(): ImageLoader = ImageLoader.Builder(this)
        .okHttpClient { repo.api.http }
        .diskCache { DiskCache.Builder().directory(cacheDir.resolve("frames")).maxSizeBytes(150L * 1024 * 1024).build() }
        .crossfade(180)
        .build()
}
