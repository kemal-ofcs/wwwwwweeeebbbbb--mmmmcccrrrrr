"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import {
  analyzeFrame,
  evaluateChallengeSignals,
  evaluateLivenessSession,
  type FrameSignals,
  LIVENESS_CHALLENGE_LABEL,
  LIVENESS_FRAME_HEIGHT,
  LIVENESS_FRAME_WIDTH,
  type LivenessChallenge,
  type LivenessFrame,
} from "@/lib/security/face-liveness";
import type { LivenessFramePayload } from "@/lib/security/liveness-codec";
import { encodeFrameBytes } from "@/lib/security/liveness-codec";

/**
 * Jarak antar-frame. Perangkat lambat otomatis menghasilkan lebih sedikit
 * frame per detik; itu tidak menjadi masalah karena tidak ada tenggat.
 */
const FRAME_GAP_MS = 110;
/**
 * Panjang jendela bergulir yang dinilai — sekitar 2,6 detik gerakan terakhir.
 *
 * Penilaian dijalankan ulang atas jendela ini pada SETIAP frame baru, jadi
 * gerakan yang benar akan tertangkap kapan pun ia dilakukan. Tidak ada lagi
 * "jendela perekaman" yang bisa menutup tepat sebelum pengguna berkedip.
 */
const ROLLING_FRAMES = 24;
/** Frame minimal sebelum jendela mulai dinilai, supaya garis dasarnya bermakna. */
const MIN_EVAL_FRAMES = 10;
/** Jeda membaca instruksi sebelum sistem mulai memperhatikan. */
const PREPARE_MS = 900;
/** Lama tanda centang ditahan supaya pengguna sempat melihat langkahnya diterima. */
const CONFIRM_MS = 800;
/**
 * Jaring pengaman, bukan tenggat. Setelah sekian lama tanpa gerakan yang
 * terbaca, sistem menawarkan bantuan — pengguna tidak pernah dilempar keluar.
 */
const HINT_AFTER_MS = 22_000;
const PHOTO_WIDTH = 480;
const PHOTO_HEIGHT = 360;

type Phase =
  | "idle"
  | "aiming"
  | "prepare"
  | "watching"
  | "confirmed"
  | "stuck"
  | "done"
  | "error";

export interface LivenessCaptureResult {
  frames: LivenessFramePayload[];
  photoBase64: string;
  photoMime: string;
}

interface LivenessCaptureProps {
  challenges: readonly LivenessChallenge[];
  busy: boolean;
  onComplete: (result: LivenessCaptureResult) => void;
  onCancel: () => void;
  /**
   * Meminta server mengganti tantangan pada langkah ini. Dipakai ketika sebuah
   * tantangan memang tidak pernah terbaca oleh kamera perangkat.
   */
  onSwapChallenge?: (stepIndex: number) => Promise<void>;
}

/**
 * Verifikasi wajah berkelanjutan, mengikuti pola aplikasi perbankan.
 *
 * Sistem menampilkan satu instruksi lalu MEMPERHATIKAN TERUS sampai gerakan itu
 * benar-benar terbaca — tidak ada hitungan mundur dan tidak ada jendela
 * perekaman yang bisa berakhir sebelum pengguna sempat bergerak. Begitu terbaca,
 * langkah itu dikunci dengan tanda centang lalu instruksi berikutnya muncul.
 *
 * Versi sebelumnya merekam selama durasi tetap lalu menilai sekali di akhir;
 * kedipan yang terjadi setengah detik setelah jendela ditutup dianggap gagal,
 * dan seluruh langkah harus diulang. Itulah sebab utama satu permintaan bisa
 * perlu belasan kali percobaan.
 */
export function LivenessCapture({
  challenges,
  busy,
  onComplete,
  onCancel,
  onSwapChallenge,
}: LivenessCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Frame dari langkah yang sudah diterima, berurutan per tantangan. */
  const acceptedRef = useRef<LivenessFrame[][]>([]);
  /** Jendela bergulir langkah yang sedang berjalan. */
  const windowFramesRef = useRef<LivenessFrame[]>([]);
  const windowSignalsRef = useRef<FrameSignals[]>([]);
  const startedAtRef = useRef(0);
  const watchStartedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [challengeIndex, setChallengeIndex] = useState(0);
  const [faceVisible, setFaceVisible] = useState(false);
  const [signal, setSignal] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const stream = videoRef.current?.srcObject;
    if (stream instanceof MediaStream) {
      for (const track of stream.getTracks()) track.stop();
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // Pembersihan saat unmount SAJA. Menautkannya ke effect yang bergantung pada
  // state akan mematikan kamera WebView Android tepat setelah dibuka.
  useEffect(() => () => stopCamera(), [stopCamera]);

  const readCanvas = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;
    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
    }
    return { video, canvas: canvasRef.current };
  }, []);

  const grabFrame = useCallback(
    (challenge: LivenessChallenge): LivenessFrame | null => {
      const surface = readCanvas();
      if (!surface) return null;
      const { video, canvas } = surface;
      canvas.width = LIVENESS_FRAME_WIDTH;
      canvas.height = LIVENESS_FRAME_HEIGHT;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(
        video,
        0,
        0,
        LIVENESS_FRAME_WIDTH,
        LIVENESS_FRAME_HEIGHT,
      );
      const image = context.getImageData(
        0,
        0,
        LIVENESS_FRAME_WIDTH,
        LIVENESS_FRAME_HEIGHT,
      );
      // RGBA -> RGB: kanal alfa selalu 255 pada tangkapan kamera dan hanya
      // membengkakkan payload sepertiga tanpa menambah informasi.
      const rgb = new Uint8Array(
        LIVENESS_FRAME_WIDTH * LIVENESS_FRAME_HEIGHT * 3,
      );
      for (let index = 0; index < rgb.length / 3; index += 1) {
        rgb[index * 3] = image.data[index * 4] as number;
        rgb[index * 3 + 1] = image.data[index * 4 + 1] as number;
        rgb[index * 3 + 2] = image.data[index * 4 + 2] as number;
      }
      return {
        challenge,
        offsetMs: Math.round(performance.now() - startedAtRef.current),
        width: LIVENESS_FRAME_WIDTH,
        height: LIVENESS_FRAME_HEIGHT,
        rgb,
      };
    },
    [readCanvas],
  );

  const grabPhoto = useCallback(() => {
    const surface = readCanvas();
    if (!surface) return "";
    const { video, canvas } = surface;
    canvas.width = PHOTO_WIDTH;
    canvas.height = PHOTO_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) return "";
    context.drawImage(video, 0, 0, PHOTO_WIDTH, PHOTO_HEIGHT);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  }, [readCanvas]);

  const startCamera = useCallback(async () => {
    setMessage(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase("error");
      setMessage("No camera is available on this device.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      });
      const video = videoRef.current;
      if (!video) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      video.srcObject = stream;
      await video.play();
      acceptedRef.current = [];
      windowFramesRef.current = [];
      windowSignalsRef.current = [];
      startedAtRef.current = performance.now();
      setChallengeIndex(0);
      setPhase("aiming");
    } catch {
      setPhase("error");
      setMessage(
        "Camera permission was denied. Allow camera access and try again: face verification is required to recover a password.",
      );
    }
  }, []);

  // Gerbang penempatan wajah: menunggu sampai wajah benar-benar terdeteksi
  // sebelum instruksi diberikan, supaya frame gelap saat kamera masih menyetel
  // eksposur tidak ikut dinilai.
  useEffect(() => {
    if (phase !== "aiming") return;
    const challenge = challenges[challengeIndex];
    if (!challenge) return;
    let stable = 0;
    const tick = () => {
      const frame = grabFrame(challenge);
      const detected = frame ? analyzeFrame(frame).faceDetected : false;
      setFaceVisible(detected);
      stable = detected ? stable + 1 : 0;
      if (stable >= 3) {
        setPhase("prepare");
        return;
      }
      timerRef.current = setTimeout(tick, 160);
    };
    timerRef.current = setTimeout(tick, 160);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [phase, challengeIndex, challenges, grabFrame]);

  useEffect(() => {
    if (phase !== "prepare") return;
    timerRef.current = setTimeout(() => {
      windowFramesRef.current = [];
      windowSignalsRef.current = [];
      watchStartedAtRef.current = performance.now();
      setPhase("watching");
    }, PREPARE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [phase]);

  // Inti pola perbankan: memperhatikan tanpa henti, menilai ulang jendela
  // bergulir setiap frame, dan berhenti pada detik gerakan itu terbaca.
  useEffect(() => {
    if (phase !== "watching") return;
    const challenge = challenges[challengeIndex];
    if (!challenge) return;

    const tick = () => {
      const frame = grabFrame(challenge);
      if (frame) {
        const signals = analyzeFrame(frame);
        setFaceVisible(signals.faceDetected);
        setSignal(signals.eyeOpenness);

        windowFramesRef.current.push(frame);
        windowSignalsRef.current.push(signals);
        if (windowFramesRef.current.length > ROLLING_FRAMES) {
          windowFramesRef.current.shift();
          windowSignalsRef.current.shift();
        }

        if (windowSignalsRef.current.length >= MIN_EVAL_FRAMES) {
          const verdict = evaluateChallengeSignals(
            challenge,
            windowSignalsRef.current,
          );
          if (verdict.passed) {
            acceptedRef.current[challengeIndex] = [...windowFramesRef.current];
            setMessage(null);
            setPhase("confirmed");
            return;
          }
        }
      }

      if (performance.now() - watchStartedAtRef.current > HINT_AFTER_MS) {
        setPhase("stuck");
        return;
      }
      timerRef.current = setTimeout(tick, FRAME_GAP_MS);
    };

    timerRef.current = setTimeout(tick, FRAME_GAP_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [phase, challengeIndex, challenges, grabFrame]);

  // Tanda centang ditahan sebentar supaya langkah yang diterima terasa selesai,
  // baru instruksi berikutnya muncul.
  useEffect(() => {
    if (phase !== "confirmed") return;
    timerRef.current = setTimeout(() => {
      if (challengeIndex + 1 < challenges.length) {
        setChallengeIndex(challengeIndex + 1);
        setPhase("aiming");
        return;
      }

      // Server menilai ulang SELURUH rangkaian dengan pemeriksaan tambahan
      // (porsi frame berwajah dan mikro-gerak). Diperiksa di sini lebih dulu
      // supaya kegagalan itu tidak muncul setelah semua langkah tuntas.
      const whole = evaluateLivenessSession(
        challenges,
        acceptedRef.current.flat(),
      );
      if (!whole.passed) {
        setMessage(whole.reason);
        setPhase("stuck");
        return;
      }

      const photoBase64 = grabPhoto();
      setPhase("done");
      stopCamera();
      onCompleteRef.current({
        frames: acceptedRef.current.flat().map((frame) => ({
          challenge: frame.challenge,
          offsetMs: frame.offsetMs,
          width: frame.width,
          height: frame.height,
          rgb: encodeFrameBytes(frame.rgb),
        })),
        photoBase64,
        photoMime: "image/jpeg",
      });
    }, CONFIRM_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [phase, challengeIndex, challenges, grabPhoto, stopCamera]);

  const keepTrying = () => {
    setMessage(null);
    windowFramesRef.current = [];
    windowSignalsRef.current = [];
    setPhase("aiming");
  };

  const swapChallenge = async () => {
    if (!onSwapChallenge) return;
    setMessage(null);
    try {
      await onSwapChallenge(challengeIndex);
      keepTrying();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "A replacement challenge could not be loaded.",
      );
      setPhase("stuck");
    }
  };

  const challenge = challenges[challengeIndex];
  const watching = phase === "watching";
  const active =
    phase === "aiming" ||
    phase === "prepare" ||
    watching ||
    phase === "confirmed";

  return (
    <div className="space-y-4">
      <ol className="flex gap-2">
        {challenges.map((item, index) => (
          <li key={item} className="flex-1">
            <div
              className={`h-1.5 rounded-full ${
                index < challengeIndex ||
                (index === challengeIndex && phase === "confirmed")
                  ? "bg-success"
                  : index === challengeIndex
                    ? "bg-secondary"
                    : "bg-surface-container"
              }`}
            />
            <p
              className={`mt-1 text-body-sm font-semibold ${
                index < challengeIndex
                  ? "text-success"
                  : index === challengeIndex
                    ? "text-secondary"
                    : "text-on-surface-variant"
              }`}
            >
              {index < challengeIndex ? "Done" : `Step ${index + 1}`}
            </p>
          </li>
        ))}
      </ol>

      <div className="relative overflow-hidden rounded-lg border border-surface-container bg-inverse-surface">
        {/* Cermin: orang melihat dirinya seperti di cermin, jadi instruksi
            "tengok kiri" terasa alami. Analisis tetap pada piksel asli. */}
        <video
          ref={videoRef}
          playsInline
          muted
          className="aspect-[4/3] w-full scale-x-[-1] object-cover"
        >
          <track kind="captions" />
        </video>

        {phase === "idle" || phase === "error" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-inverse-surface/90 p-6 text-center">
            <p className="text-body-md text-inverse-on-surface">
              Your face will be recorded as evidence for this password recovery
              request.
            </p>
            <button
              type="button"
              onClick={() => void startCamera()}
              disabled={busy}
              className="app-btn app-btn-primary"
            >
              {phase === "error" ? "Try again" : "Turn on camera"}
            </button>
          </div>
        ) : null}

        {phase === "confirmed" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-inverse-surface/70">
            <div className="grid size-16 place-items-center rounded-full bg-success text-on-secondary">
              <Icon name="check" className="size-8" />
            </div>
            <p className="text-body-md font-semibold text-inverse-on-surface">
              Captured
            </p>
          </div>
        ) : null}

        {active && phase !== "confirmed" ? (
          <div className="absolute inset-x-0 bottom-0 space-y-1 bg-inverse-surface/85 p-3">
            <p className="text-center font-mono text-label-caps uppercase text-inverse-on-surface">
              Step {challengeIndex + 1} of {challenges.length}
            </p>
            <p className="text-center text-headline-lg text-inverse-on-surface">
              {challenge ? LIVENESS_CHALLENGE_LABEL[challenge] : ""}
            </p>
            <p className="text-center text-body-sm text-inverse-on-surface">
              {phase === "aiming"
                ? faceVisible
                  ? "Face detected..."
                  : "Center your face in the frame."
                : phase === "prepare"
                  ? "Get ready..."
                  : faceVisible
                    ? "Go ahead, there is no rush."
                    : "Your face left the frame. Move closer."}
            </p>
          </div>
        ) : null}

        {phase === "stuck" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-inverse-surface/90 p-6 text-center">
            <p className="text-body-md font-semibold text-inverse-on-surface">
              The movement was not captured yet
            </p>
            <p className="max-w-xs text-body-sm text-inverse-on-surface">
              {message ??
                "Add light in front of your face, move closer until your face fills a third of the frame, then make the movement more clearly."}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={keepTrying}
                className="app-btn app-btn-primary"
              >
                Try again
              </button>
              {onSwapChallenge ? (
                <button
                  type="button"
                  onClick={() => void swapChallenge()}
                  className="app-btn app-btn-secondary"
                >
                  Try a different challenge
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {watching ? (
        <div className="space-y-2">
          <p className="text-center text-body-sm text-on-surface-variant">
            Watching now. This step continues automatically as soon as your
            movement is captured.
          </p>
          {challenge === "KEDIP" ? (
            // Bilah sinyal mata: pengguna bisa melihat sendiri apakah
            // kedipannya terbaca kamera, alih-alih menebak setelah gagal.
            <div>
              <p className="text-body-sm text-on-surface-variant">
                Eye signal: it should drop sharply when you blink
              </p>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-container">
                <div
                  className="h-full rounded-full bg-secondary transition-[width] duration-100"
                  style={{ width: `${Math.min(100, signal * 400)}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {message && phase !== "stuck" ? (
        <p
          role="alert"
          className="rounded-md border border-error/30 bg-error-container p-3 text-body-md text-on-error-container"
        >
          {message}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            stopCamera();
            onCancel();
          }}
          className="app-btn app-btn-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
