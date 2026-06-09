# Project Eagle: Spatial AI Head-Orientation Privacy Sentry

Project Eagle is a high-performance, real-time spatial privacy monitor that shields sensitive screen data from unauthorized shoulder-surfing. By leveraging web-native computer vision and 3D facial coordinate topology, Project Eagle acts as a silent sentry, continuously calculating the probability that nearby individuals are snooping on your screen and executing immediate security countermeasures upon threat confirmation.

---

## 📋 Table of Contents
1. [The Problem Statement](#-the-problem-statement)
2. [What is Project Eagle & What It Solves](#-what-is-project-eagle--what-it-solves)
3. [Key Features](#-key-features)
4. [How the App Works (Step-by-Step)](#-how-the-app-works-step-by-step)
5. [Technical Workflow & State Machine](#-technical-workflow--state-machine)
6. [Geometric Gaze & Score Mathematics](#-geometric-gaze--score-mathematics)
7. [Tech Stack](#-tech-stack)
8. [Future Enhancements](#-future-enhancements)
9. [Running Locally](#-running-locally)

---

## 🔍 The Problem Statement

In an increasingly mobile world, developers, designers, financial officers, and everyday users frequently work on sensitive information in public spaces—such as cafes, co-working offices, airports, and public transit.

### The Vulnerability: "Shoulder-Surfing"
Shoulder-surfing (the act of looking over someone's shoulder to obtain credentials, proprietary code, or personal communications) is a highly prevalent physical security threat.
- **Limits of Physical Filters**: Traditional plastic privacy filters restrict horizontal viewing angles but are useless against observers directly behind the user. Furthermore, they degrade screen clarity and color representation for the primary user.
- **Cognitive Overhead**: Manually checking one's surroundings is disruptive, unreliable, and detracts from focus.
- **Intent vs. Presence**: Existing webcam solutions often flag *any* face in the frame as a threat. This causes high rates of false alarms when coworkers walk past or stand nearby without actually looking at the screen, resulting in user frustration and eventually disabling the safety software.

---

## 🛡️ What is Project Eagle & What It Solves

Project Eagle solves physical screen privacy by introducing **autonomous spatial awareness**. Instead of merely detecting the presence of a face, it uses geometric calculations to determine **attentional direction** and **viewing stability**.

### The Core Solution
Project Eagle continuously monitors the environment and ensures:
1. **Zero False Positives on Passersby**: Passersby looking elsewhere are classified as *Neutral* and ignored.
2. **Intent Verification**: The system evaluates head stability, visibility quality, and exact yaw/pitch angles over time before escalating a detection to a *Threat*.
3. **Automated Deflection**: Upon confirming an unauthorized observer, the system instantly blurs the screen canvas, triggers visual and acoustic alarms, and issues desktop notifications.

---

## ✨ Key Features

- **Centroid-Based Unique Face Tracking**: Tracks multiple individuals simultaneously. Each face receives a persistent tracking ID (e.g. `Face #1`, `Face #2`) based on spatial coordinate clustering, maintaining state across frames.
- **Primary User Verification Lock**: During a 5-second startup calibration phase, the sentry locks onto the face closest to the screen center. Once locked, this face is anchored as the authenticated user. Even if the user steps out of the frame, background observers cannot hijack the primary session.
- **Uncertainty "Unknown" State**: Automatically classifies partial faces, motion blur, poor lighting, or extreme angles as `Unknown`. The HUD draws a dashed slate-gray frame, and the system defaults to **SAFE**, conforming to the strict anti-hallucination policy.
- **Stealth Radar Display**: Toggle between a standard webcam video feed with corner-bracket HUD elements and a premium **Cyber Sonar Sweep Radar** view that renders face positions and gaze vectors on a dark vector coordinate grid.
- **Dual Alarm Countermeasures**: Triggers a clean, double-chirp digital audio siren using the browser Web Audio API, flashes the document title (`🚨 LOCKDOWN 🚨`), and pushes native OS notifications.
- **Configurable Threat Activation Window**: Customizable countdown timer ($1$ to $10$ seconds) via a clean dropdown to adjust security levels based on setting.

---

## 🚶 How the App Works (Step-by-Step)

```
[ User Clicks "Start Protection" ]
       │
       ▼
[ Step 1: Camera & Web Worker Initialization ] ──► (Loads MediaPipe scripts & starts background thread)
       │
       ▼
[ Step 2: Primary User Verification (5s) ] ────► (Calibrates on central face, locks primary ID)
       │
       ▼
[ Step 3: Real-Time Sentry Monitoring Loop ] ───► (Tracks centroids, checks orientation & quality)
       │
       ├─► [ Secondary Face Looking Away ] ────► (Classified as Neutral; confidence stays low)
       │
       └─► [ Secondary Face Looking at Screen ] ► (Scoring triggers; confidence builds)
               │
               ▼ (Confidence exceeds 61% & face is stable)
       [ Step 4: Threat Timer Accumulation ] ──► (Starts countdown window)
               │
               ├─► [ Observer Looks Away ] ────► (Timer pauses or decays back to 0.0s)
               │
               ▼ (Timer completes activation window)
       [ Step 5: Screen Breach & Alarm ] ──────► (Screen blurs, siren plays, desktop alert fires)
```

1. **Initialization**: The user starts theSentries. The app initializes the webcam feed and launches an isolated **Web Worker**. The Web Worker continuously dispatches images to the **MediaPipe Face Mesh** API, ensuring that processing is offloaded and the browser UI thread never drops below 60fps.
2. **Calibration & Verification**: The UI prompts the primary user to look at the screen. Over 5 seconds, the system calculates the face closest to the absolute center `(0.5, 0.5)` and locks their Face ID.
3. **Passive Surveillance**: As new frames arrive, the centroid tracker associates face positions. Face paths are plotted as either standard coordinates or sonar sweeps.
4. **Threat Assessment**: For any face that is *not* the primary user, the system evaluates three distinct mathematical scores: **Orientation**, **Stability**, and **Visibility Quality**.
5. **Confidence Scaling**: The raw score is calculated by weighing the orientation, stability, and quality, and then multiplying by a **Persistence Duration** curve. This builds up confidence slowly over 3 seconds to avoid triggers on quick head turns.
6. **Escalation & Countermeasures**: If the confidence hits the threshold ($\ge 61\%$), the threat timer begins ticking. If the timer exceeds the threshold (e.g. 5 seconds), the UI enters the **BREACH** state, blurring the main interface and triggering alarms.

---

## 📉 Geometric Gaze & Score Mathematics

All computations are done in real-time on normalized 2D/3D facial vertices:

### 1. Estimated Screen-Facing Orientation Score ($S_{ori}$)
We estimate the head-pose direction using key landmark vectors:
- **Landmarks used**: Left Outer Eye (`33`), Right Outer Eye (`263`), Nose Tip (`1`), Nose Bridge (`4`), Left Mouth Corner (`61`), Right Mouth Corner (`291`), Left Cheek (`234`), Right Cheek (`454`).
- **Yaw (Horizontal)**: Computes the asymmetry ratio of the nose tip relative to the horizontal width of the face cheeks.
  $$YawRatio = \frac{|x_{nose} - x_{leftCheek}|}{|x_{rightCheek} - x_{leftCheek}|}$$
  $$S_{yaw} = \max\left(0, 1 - \frac{|YawRatio - 0.5|}{0.15}\right)$$
- **Pitch (Vertical)**: Computes the vertical nose tip displacement relative to the eye-to-mouth distance.
  $$PitchRatio = \frac{y_{nose} - y_{eyeCenter}}{|y_{mouthCenter} - y_{eyeCenter}|}$$
  $$S_{pitch} = \max\left(0, 1 - \frac{|PitchRatio - 0.45|}{0.3}\right)$$
- **Orientation Score**:
  $$S_{ori} = S_{yaw} \times S_{pitch}$$

### 2. Stability Score ($S_{stab}$)
Evaluated by calculating the moving average displacement of the face center over the last 10 frames ($\overline{d_{10}}$).
$$S_{stab} = \max\left(0, \min\left(1, 1 - \frac{\overline{d_{10}} - 0.005}{0.035}\right)\right)$$
If a face moves erratically or suffers from motion blur, $S_{stab} \to 0$.

### 3. Visibility Quality Score ($S_{vis}$)
Evaluates the clarity of the facial coordinates:
- **Edge Distance**:
  $$d_{edge} = \min(x_{min}, 1 - x_{max}, y_{min}, 1 - y_{max})$$
  $$S_{edge} = \max\left(0, \min\left(1, \frac{d_{edge}}{0.08}\right)\right)$$
- **Aspect Ratio Deviation**: Checks if the face conforms to standard vertical bounds:
  $$S_{aspect} = \max\left(0, 1 - \frac{|Ratio_{bounds} - 0.75|}{0.4}\right)$$
- **Visibility Score**:
  $$S_{vis} = S_{edge} \times S_{aspect}$$

### 4. Persistence Duration Score ($S_{dur}$)
Smooths entry triggers over a 3-second window:
$$S_{dur} = \min\left(1.0, \frac{\text{Tracking Duration (ms)}}{3000}\right)$$

### 5. Final Confidence Framework
If $S_{stab} < 0.4$ or $S_{vis} < 0.5$, the face defaults to `Unknown` state with $0\%$ confidence. Otherwise:
$$Confidence = (S_{ori} \times 0.5 + S_{stab} \times 0.25 + S_{vis} \times 0.25) \times S_{dur} \times 100\%$$

---

## 💻 Tech Stack

- **Frontend Core**: Vanilla HTML5, CSS3 Variables (mesh gradients, glassmorphism filters).
- **Sentry Engine**: Pure JavaScript (ES6 Modules) - completely framework-free for lightning-fast loads.
- **Machine Learning**: MediaPipe FaceMesh API.
- **Multi-Threading**: HTML5 Web Workers API (isolated frame processing).
- **Countermeasure Audio**: Web Audio API (sine-wave frequency sweeping synthesizer).
- **System Actions**: Web Notifications API (native desktop alert routing).

---

## 🔮 Future Enhancements

1. **Iris Gaze-Vector Tracking**: Incorporate MediaPipe Iris to track eye-gaze vectors independently from head orientation, allowing detection of lateral eye glances.
2. **Local Biometric Signature Hashing**: Create a temporary vector embedding hash of the primary user's face shape (without storing any raw images) to remember them even if they leave and return.
3. **Distance-Based Screen Scaling**: Estimate distance to screen via iris scale math and automatically enlarge text/interfaces or adjust threat bounds dynamically.
4. **OS Locking Integrations**: Package with Electron to allow direct integration with native lock screen commands (`Rundll32.exe user32.dll,LockWorkStation` on Windows or `pmset displaysleepnow` on macOS) when a breach is verified.

---

## 🚀 Running Locally

To host Project Eagle locally:
1. Propose running python server:
   ```powershell
   python -m http.server 8000
   ```
2. Navigate to `http://localhost:8000/` in your browser.
3. Grant camera permissions.
