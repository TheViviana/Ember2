/**
 * 画布节点卡片的 CSS Modules 类名映射。
 *
 * engine 只负责取哈希类名；把五组映射集中在此，避免装配文件随卡片种类增长。
 */
import type { AiNodeCardClassNames } from './ai-node-card.ts';
import type {
  NodeDocClassNames,
  NodeMediaClassNames,
  NodeSimpleClassNames,
  NodeStepClassNames,
} from './node-layer.ts';

export interface CanvasNodeClassNames {
  readonly media: NodeMediaClassNames;
  readonly doc: NodeDocClassNames;
  readonly simple: NodeSimpleClassNames;
  readonly ai: AiNodeCardClassNames;
  readonly step: NodeStepClassNames;
}

export function createCanvasNodeClassNames(
  classOf: (name: string) => string,
): CanvasNodeClassNames {
  return {
    media: {
      image: classOf('mediaImage'), label: classOf('mediaLabel'), placeholder: classOf('mediaPlaceholder'),
      kicker: classOf('mediaKicker'), kickerBadge: classOf('mediaKickerBadge'),
      surface: classOf('mediaSurface'), footer: classOf('mediaFooter'), document: classOf('mediaDocument'),
      player: classOf('media-player'), audioEl: classOf('mediaAudioEl'),
      audioPlayer: classOf('mediaAudioPlayer'), audioPlay: classOf('mediaAudioPlay'),
      audioTrack: classOf('mediaAudioTrack'), audioFill: classOf('mediaAudioFill'), audioTime: classOf('mediaAudioTime'),
    },
    doc: {
      body: classOf('docBody'), summary: classOf('docSummary'),
      kicker: classOf('docKicker'), kickerBadge: classOf('docKickerBadge'),
      footer: classOf('docFooter'),
      tags: classOf('docTags'), tag: classOf('docTag'), meta: classOf('docMeta'),
      links: classOf('docLinks'), linkOut: classOf('docLinkOut'), linkBack: classOf('docLinkBack'),
      content: classOf('docContent'), clip: classOf('docClip'), text: classOf('docText'),
      hint: classOf('docHint'), expand: classOf('docExpand'),
    },
    simple: {
      title: classOf('nodeCardTitle'), icon: classOf('nodeCardIcon'),
      content: classOf('nodeCardContent'), run: classOf('nodeRunBtn'), empty: classOf('nodeCardEmpty'),
      footer: classOf('nodeCardFooter'), edit: classOf('nodeEditBtn'),
    },
    ai: {
      root: classOf('aiCard'), header: classOf('aiHeader'), title: classOf('aiTitle'),
      model: classOf('aiModel'), prompt: classOf('aiPrompt'), footer: classOf('aiFooter'),
      run: classOf('aiRun'),
      runner: classOf('aiRunner'), runnerGlow: classOf('aiRunnerGlow'), runnerCore: classOf('aiRunnerCore'),
    },
    step: {
      root: classOf('stepCard'), header: classOf('stepHeader'), title: classOf('stepTitle'),
      model: classOf('stepModel'), body: classOf('stepBody'), meta: classOf('stepMeta'),
      chip: classOf('stepChip'), preview: classOf('stepPreview'),
      footer: classOf('stepFooter'), status: classOf('stepStatus'), run: classOf('stepRun'),
    },
  };
}