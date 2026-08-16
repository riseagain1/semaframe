import { Composition, Folder, Still } from "remotion";
import { SemaFrameDemo, SemaFramePoster } from "./SemaFrameDemo";
import { SemaFrameShort } from "./SemaFrameShort";

export const FPS = 30;

export const RemotionRoot = () => (
  <>
    <Folder name="Launch">
      <Composition
        id="SemaFrameHero"
        component={SemaFrameDemo}
        width={1920}
        height={1080}
        fps={FPS}
        durationInFrames={78 * FPS}
      />
      <Composition
        id="SemaFrameShort"
        component={SemaFrameShort}
        width={1080}
        height={1920}
        fps={FPS}
        durationInFrames={18 * FPS}
      />
      <Still id="SemaFramePoster" component={SemaFramePoster} width={1920} height={1080} />
    </Folder>
  </>
);
