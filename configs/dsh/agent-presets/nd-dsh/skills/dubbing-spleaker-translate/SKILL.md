---
name: dubbing-spleaker-translate
description: Translate SRT subtitles into natural Khmer suitable for professional movie dubbing, keeping timecodes and speaker tags unchanged.
---

Translate the following subtitles into natural Khmer suitable for professional movie dubbing.

Requirements:
- Keep the exact SRT format unchanged.
- Preserve subtitle numbering exactly.
- Preserve all original timecodes exactly.
- Keep all speaker tags such as [SPEAKER_00], [SPEAKER_01], [Alice], etc.
- Do not remove, rename, translate, or reorder speaker tags.
- Translate only the dialogue text into Khmer.
- Make the Khmer sound natural, emotional, conversational, and easy for voice actors to perform.
- Use short, smooth sentences that fit the subtitle timing.
- Match the character tone, emotion, urgency, and relationship in each scene.
- Prefer spoken Khmer for dubbing, not stiff written Khmer.
- Avoid overly formal Khmer unless the character or scene requires it.
- Keep line length practical for subtitle timing and mouth movement.
- If a line is already Khmer, lightly improve naturalness only when needed.
- Do not add explanations, notes, markdown, code fences, or extra formatting.
- Output ONLY valid SRT subtitles.

Goal:
The final result should feel like professionally localized Khmer movie dubbing subtitles with natural timing, clear speaker continuity, and believable spoken performance.

Example:
Subtitles to translate:
1
00:00:02,140 --> 00:00:18,170
[SPEAKER_00] 已经走了爹爹爹你醒醒爹你醒醒我给你拿药了大夫说了大夫说吃药就能好爹我给你拿药

2
00:00:18,170 --> 00:00:19,980
[SPEAKER_02] 大

Output:
1
00:00:02,140 --> 00:00:18,170
[SPEAKER_00] ឪពុក! ឪពុក! ភ្ញាក់ឡើងទៅ! ពុកអើយ ភ្ញាក់ឡើង! កូនយកថ្នាំមកឱ្យពុកហើយ! លោកគ្រូពេទ្យប្រាប់ថា ឱ្យតែលេបថ្នាំ ពុកនឹងបានជាសះស្បើយ! ពុកអើយ កូនយកថ្នាំមកហើយ!

2
00:00:18,170 --> 00:00:19,980
[SPEAKER_02] លោកគ្រូ
