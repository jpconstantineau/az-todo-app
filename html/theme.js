// Runs before CSS to apply validated browser-local appearance before first paint.
(() => {
  const MODE_KEY = 'todo-appearance', STYLE_KEY = 'todo-style-theme', CUSTOM_KEY = 'todo-custom-theme';
  const modes = ['light', 'dark', 'system'], styles = ['hashicorp', 'hmi', 'hmi-cvd', 'custom'];
  const colorNames = ['canvas', 'surface', 'surfaceRaised', 'ink', 'muted', 'border', 'controlBorder', 'link', 'focus', 'primary', 'onPrimary', 'selected', 'success', 'warning', 'error'];
  const tokenRules = {
    font: { type:'choice', choices:['system','humanist'] }, textXs:{min:11,max:16}, textSm:{min:12,max:18}, textBase:{min:14,max:22}, textLg:{min:16,max:28}, textHeading:{min:18,max:36}, textTitle:{min:22,max:48},
    weightBody:{min:400,max:600}, weightEmphasis:{min:500,max:700}, weightTitle:{min:600,max:800}, lineBody:{min:1.3,max:1.8,step:.05}, lineHeading:{min:1.1,max:1.5,step:.01},
    space1:{min:2,max:8}, space2:{min:4,max:16}, space3:{min:6,max:24}, space4:{min:8,max:32}, space5:{min:10,max:40}, space6:{min:12,max:48}, space8:{min:16,max:64},
    radiusControl:{min:0,max:24}, radiusPanel:{min:0,max:32}, borderWidth:{min:1,max:4}, focusWidth:{min:2,max:6}, disabledOpacity:{min:.5,max:.85,step:.05}, target:{min:44,max:64},
    elevation:{type:'choice',choices:['flat','subtle']}, motion:{type:'choice',choices:['none','standard']}
  };
  const hashicorp = {
    version:1, name:'HashiCorp',
    light:{canvas:'#f7f8fa',surface:'#ffffff',surfaceRaised:'#eef0f4',ink:'#15181e',muted:'#515865',border:'#d4d8df',controlBorder:'#747b88',link:'#005ec4',focus:'#005ec4',primary:'#15181e',onPrimary:'#ffffff',selected:'#e2eeff',success:'#08764f',warning:'#805600',error:'#b42318'},
    dark:{canvas:'#000000',surface:'#15181e',surfaceRaised:'#1f232b',ink:'#ffffff',muted:'#b2b6bd',border:'#3b3d45',controlBorder:'#858c99',link:'#2b89ff',focus:'#2b89ff',primary:'#ffffff',onPrimary:'#000000',selected:'#101a35',success:'#00ca8e',warning:'#ffcf25',error:'#ff928b'},
    tokens:{font:'system',textXs:12,textSm:14,textBase:16,textLg:18,textHeading:22,textTitle:28,weightBody:500,weightEmphasis:600,weightTitle:700,lineBody:1.5,lineHeading:1.21,space1:4,space2:8,space3:12,space4:16,space5:20,space6:24,space8:32,radiusControl:8,radiusPanel:12,borderWidth:1,focusWidth:3,disabledOpacity:.65,target:44,elevation:'flat',motion:'standard'}
  };
  const hmiColors = {
    light:{canvas:'#d4d6d8',surface:'#eceeef',surfaceRaised:'#dfe2e4',ink:'#202428',muted:'#50565c',border:'#777e85',controlBorder:'#596168',link:'#005a7a',focus:'#005a7a',primary:'#41484f',onPrimary:'#ffffff',selected:'#c3dce5',success:'#276749',warning:'#765300',error:'#9b2c2c'},
    dark:{canvas:'#202428',surface:'#2b3035',surfaceRaised:'#363c42',ink:'#edf0f2',muted:'#bcc2c8',border:'#858e97',controlBorder:'#a1aab3',link:'#7fd7f5',focus:'#7fd7f5',primary:'#c4cbd2',onPrimary:'#202428',selected:'#344f59',success:'#87d5aa',warning:'#ffd166',error:'#ffaaa5'}
  };
  const hmiTokens = {...hashicorp.tokens,textHeading:20,textTitle:26,weightTitle:600,radiusControl:4,radiusPanel:8,borderWidth:2,elevation:'flat'};
  const presets = {
    hashicorp,
    hmi:{version:1,name:'HMI',light:{...hmiColors.light},dark:{...hmiColors.dark},tokens:{...hmiTokens}},
    'hmi-cvd':{version:1,name:'HMI (CVD)',light:{...hmiColors.light,success:'#75409a',link:'#00665d',focus:'#00665d',warning:'#005f90',error:'#9b4300'},dark:{...hmiColors.dark,success:'#d6aff5',link:'#7ed8c8',focus:'#7ed8c8',warning:'#78caff',error:'#ffba75'},tokens:{...hmiTokens}}
  };
  const cssTokens = {textXs:'--text-xs',textSm:'--text-sm',textBase:'--text-base',textLg:'--text-lg',textHeading:'--text-heading',textTitle:'--text-title',weightBody:'--weight-body',weightEmphasis:'--weight-emphasis',weightTitle:'--weight-title',lineBody:'--line-body',lineHeading:'--line-heading',space1:'--space-1',space2:'--space-2',space3:'--space-3',space4:'--space-4',space5:'--space-5',space6:'--space-6',space8:'--space-8',radiusControl:'--radius-control',radiusPanel:'--radius-panel',borderWidth:'--border-width',focusWidth:'--focus-width',disabledOpacity:'--disabled-opacity',target:'--target'};
  const colorCss = {surfaceRaised:'--surface-raised',controlBorder:'--control-border',onPrimary:'--on-primary',...Object.fromEntries(colorNames.map(name => [name,`--${name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())}`]))};
  const clone = value => JSON.parse(JSON.stringify(value));
  const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === expected.length && Object.keys(value).every(key => expected.includes(key));
  function validate(candidate) {
    const errors = {};
    if (!exactKeys(candidate,['version','name','light','dark','tokens']) || candidate.version !== 1) return {valid:false,errors:{theme:'This theme format is not supported.'}};
    if (typeof candidate.name !== 'string' || !candidate.name.trim() || candidate.name.trim().length > 60) errors.name = 'Enter a name from 1 to 60 characters.';
    for (const scheme of ['light','dark']) {
      if (!exactKeys(candidate[scheme],colorNames)) { errors[scheme] = `The ${scheme} palette is incomplete.`; continue; }
      for (const name of colorNames) if (!/^#[0-9a-f]{6}$/i.test(candidate[scheme][name])) errors[`${scheme}.${name}`] = 'Use a six-digit hex color.';
    }
    if (!exactKeys(candidate.tokens,Object.keys(tokenRules))) errors.tokens = 'The design token set is incomplete.';
    else for (const [name,rule] of Object.entries(tokenRules)) {
      const value = candidate.tokens[name];
      if (rule.type === 'choice' ? !rule.choices.includes(value) : typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max) errors[`tokens.${name}`] = rule.type === 'choice' ? 'Choose a listed value.' : `Use a value from ${rule.min} to ${rule.max}.`;
    }
    return {valid:!Object.keys(errors).length,errors};
  }
  function stored(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function parseCustom(raw) { try { const candidate = JSON.parse(raw); return validate(candidate).valid ? candidate : null; } catch { return null; } }
  let mode = 'dark', style = 'hashicorp', custom = null;
  const media = matchMedia('(prefers-color-scheme: dark)');
  function activeTheme() { return style === 'custom' && custom ? custom : presets[style] || hashicorp; }
  function resolvedMode() { return mode === 'system' ? media.matches ? 'dark' : 'light' : mode; }
  function setMeta(theme) { const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = theme[resolvedMode()].canvas; }
  function apply({storageError=false} = {}) {
    const theme = activeTheme(), root = document.documentElement;
    root.dataset.theme = mode; root.dataset.styleTheme = style;
    for (const name of colorNames) root.style.setProperty(colorCss[name],`light-dark(${theme.light[name]}, ${theme.dark[name]})`);
    for (const [name,property] of Object.entries(cssTokens)) root.style.setProperty(property,`${theme.tokens[name]}${name.startsWith('text') || name.startsWith('space') || name.startsWith('radius') || ['borderWidth','focusWidth','target'].includes(name) ? 'px' : ''}`);
    root.style.setProperty('--font',theme.tokens.font === 'humanist' ? 'Inter, "Segoe UI", Helvetica, Arial, sans-serif' : '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif');
    root.style.setProperty('--panel-shadow',theme.tokens.elevation === 'subtle' ? '0 2px 8px rgb(0 0 0 / .18)' : 'none');
    root.style.setProperty('--motion-duration',theme.tokens.motion === 'standard' ? '150ms' : '0ms');
    root.style.setProperty('--numeric-variant',style.startsWith('hmi') ? 'tabular-nums' : 'normal');
    setMeta(theme);
    document.querySelectorAll('[data-appearance]').forEach(select => { select.value = mode; });
    document.querySelectorAll('[data-style-theme]').forEach(select => {
      select.value = style;
      const option = select.querySelector('option[value="custom"]');
      option?.toggleAttribute('disabled',!custom); option?.toggleAttribute('hidden',!custom);
    });
    dispatchEvent(new CustomEvent('todo-appearance-change',{detail:{mode,style,name:theme.name,custom:!!custom,storageError}}));
  }
  function restore() {
    const nextMode = stored(MODE_KEY), nextStyle = stored(STYLE_KEY), nextCustom = parseCustom(stored(CUSTOM_KEY));
    mode = modes.includes(nextMode) ? nextMode : 'dark'; custom = nextCustom;
    style = styles.includes(nextStyle) && (nextStyle !== 'custom' || custom) ? nextStyle : 'hashicorp'; apply();
  }
  function persist(key,value) { try { localStorage.setItem(key,value); return true; } catch { return false; } }
  function choose(nextMode,nextStyle) {
    if (modes.includes(nextMode)) mode = nextMode;
    if (styles.includes(nextStyle) && (nextStyle !== 'custom' || custom)) style = nextStyle;
    const saved = Boolean(persist(MODE_KEY,mode) & persist(STYLE_KEY,style)); apply({storageError:!saved}); return saved;
  }
  const title = name => name.replace(/[A-Z]/g,letter => ' ' + letter).replace(/^./,letter => letter.toUpperCase());
  const fieldGroups = [
    {name:'Light colors',fields:colorNames.map(name => ({path:`light.${name}`,label:title(name),type:'color'}))},
    {name:'Dark colors',fields:colorNames.map(name => ({path:`dark.${name}`,label:title(name),type:'color'}))},
    {name:'Typography',fields:Object.keys(tokenRules).filter(name => name === 'font' || name.startsWith('text') || name.startsWith('weight') || name.startsWith('line')).map(name => ({path:`tokens.${name}`,label:title(name),...tokenRules[name],unit:name.startsWith('text') ? 'px' : ''}))},
    {name:'Spacing and density',fields:Object.keys(tokenRules).filter(name => name.startsWith('space') || name === 'target').map(name => ({path:`tokens.${name}`,label:name === 'target' ? 'Minimum target size' : name.replace('space','Space '),...tokenRules[name],unit:'px'}))},
    {name:'Corners and borders',fields:['radiusControl','radiusPanel','borderWidth','focusWidth','disabledOpacity'].map(name => ({path:`tokens.${name}`,label:title(name),...tokenRules[name],unit:name === 'disabledOpacity' ? '' : 'px'}))},
    {name:'Depth and motion',fields:['elevation','motion'].map(name => ({path:`tokens.${name}`,label:title(name),...tokenRules[name]}))}
  ];
  window.todoAppearance = {
    modes:[...modes],styles:[...styles],fieldGroups:clone(fieldGroups),validate,
    getState:() => ({mode,style,name:activeTheme().name,hasCustom:!!custom}), getEditableTheme:() => clone(custom || activeTheme()), choose,
    saveCustom(candidate) {
      const result = validate(candidate); if (!result.valid) return result;
      custom = clone(candidate); custom.name = custom.name.trim(); style = 'custom';
      const saved = Boolean(persist(CUSTOM_KEY,JSON.stringify(custom)) & persist(STYLE_KEY,style) & persist(MODE_KEY,mode));
      apply({storageError:!saved}); return {valid:true,storageError:!saved};
    }
  };
  restore();
  document.addEventListener('DOMContentLoaded',() => apply());
  document.addEventListener('change',event => {
    if (event.target.matches('[data-appearance]')) choose(event.target.value,style);
    if (event.target.matches('[data-style-theme]')) choose(mode,event.target.value);
  });
  addEventListener('storage',event => { if ([MODE_KEY,STYLE_KEY,CUSTOM_KEY,null].includes(event.key)) restore(); });
  media.addEventListener?.('change',() => { if (mode === 'system') apply(); });
})();
