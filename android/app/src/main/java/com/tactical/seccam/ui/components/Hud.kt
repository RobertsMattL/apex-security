package com.tactical.seccam.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tactical.seccam.data.LinkState
import com.tactical.seccam.ui.theme.Tac
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// ---- surfaces ---------------------------------------------------------------

/** Faint tactical grid with a vignette; the base layer of every screen. */
fun Modifier.tacticalBackground(cell: Dp = 28.dp) = this
    .background(Tac.Void)
    .drawBehind {
        val step = cell.toPx()
        var x = 0f
        while (x < size.width) {
            drawLine(Tac.Grid, Offset(x, 0f), Offset(x, size.height), 1f); x += step
        }
        var y = 0f
        while (y < size.height) {
            drawLine(Tac.Grid, Offset(0f, y), Offset(size.width, y), 1f); y += step
        }
        drawRect(Brush.radialGradient(listOf(Color.Transparent, Color(0xCC000000)), center = center, radius = size.maxDimension * 0.75f))
    }

/** L-shaped corner marks, echoing tacticalRtsp's target brackets. */
fun Modifier.cornerBrackets(color: Color = Tac.Cyan, length: Dp = 10.dp, stroke: Dp = 1.5.dp, inset: Dp = 0.dp) = drawWithContent {
    drawContent()
    val l = length.toPx(); val s = stroke.toPx(); val i = inset.toPx()
    val w = size.width - i; val h = size.height - i
    drawLine(color, Offset(i, i), Offset(i + l, i), s); drawLine(color, Offset(i, i), Offset(i, i + l), s)
    drawLine(color, Offset(w, i), Offset(w - l, i), s); drawLine(color, Offset(w, i), Offset(w, i + l), s)
    drawLine(color, Offset(i, h), Offset(i + l, h), s); drawLine(color, Offset(i, h), Offset(i, h - l), s)
    drawLine(color, Offset(w, h), Offset(w - l, h), s); drawLine(color, Offset(w, h), Offset(w, h - l), s)
}

private val PanelShape = RoundedCornerShape(3.dp)

/** Semi-transparent glass panel: layered gradient, hairline border, optional accent brackets. */
@Composable
fun GlassPanel(
    modifier: Modifier = Modifier,
    accent: Color? = null,
    onClick: (() -> Unit)? = null,
    padding: Dp = 14.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier
            .clip(PanelShape)
            .background(Brush.verticalGradient(listOf(Tac.GlassTop, Tac.GlassBottom)))
            .background(Tac.Charcoal.copy(alpha = 0.55f))
            .border(1.dp, Tac.Hairline, PanelShape)
            .then(if (accent != null) Modifier.cornerBrackets(accent, 8.dp, 1.5.dp) else Modifier)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(padding),
        content = content,
    )
}

// ---- text -------------------------------------------------------------------

@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier, trailing: @Composable RowScope.() -> Unit = {}) {
    Row(modifier.fillMaxWidth().padding(top = 18.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("// ${text.uppercase()}", style = Tac.Label.copy(color = Tac.Cyan.copy(alpha = 0.85f)))
        Box(Modifier.weight(1f).padding(horizontal = 10.dp).height(1.dp).background(Brush.horizontalGradient(listOf(Tac.Hairline, Color.Transparent))))
        trailing()
    }
}

@Composable
fun KeyValue(key: String, value: String, valueColor: Color = Tac.Text, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(key.uppercase(), style = Tac.Label, modifier = Modifier.width(112.dp))
        Text(value, style = Tac.Data.copy(color = valueColor), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun Chip(text: String, color: Color = Tac.TextDim, filled: Boolean = false, onClick: (() -> Unit)? = null) {
    Box(
        Modifier
            .clip(RoundedCornerShape(2.dp))
            .background(if (filled) color.copy(alpha = 0.16f) else Color.Transparent)
            .border(1.dp, color.copy(alpha = if (filled) 0.7f else 0.35f), RoundedCornerShape(2.dp))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 7.dp, vertical = 3.dp),
    ) {
        Text(text.uppercase(), style = Tac.DataSmall.copy(color = color, letterSpacing = 1.2.sp))
    }
}


// ---- status -----------------------------------------------------------------

@Composable
fun StatusPip(color: Color, pulse: Boolean = false, size: Dp = 7.dp) {
    val alpha = if (pulse) {
        val t = rememberInfiniteTransition(label = "pip")
        t.animateFloat(0.35f, 1f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "pipA").value
    } else 1f
    Box(Modifier.size(size + 6.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(size + 6.dp).clip(CircleShape).background(color.copy(alpha = 0.12f * alpha)))
        Box(Modifier.size(size).clip(CircleShape).background(color.copy(alpha = alpha)))
    }
}

fun streamColor(stream: String) = when (stream) {
    "online" -> Tac.Green
    "connecting" -> Tac.Amber
    "disabled" -> Tac.TextFaint
    else -> Tac.Red
}

@Composable
fun LinkIndicator(state: LinkState) {
    val (c, label) = when (state) {
        LinkState.ONLINE -> Tac.Green to "LINK"
        LinkState.CONNECTING -> Tac.Amber to "SYNC"
        LinkState.OFFLINE -> Tac.Red to "NO LINK"
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        StatusPip(c, pulse = state != LinkState.ONLINE, size = 6.dp)
        Text(label, style = Tac.DataSmall.copy(color = c))
    }
}

/** UTC-style running clock for HUD corners. */
@Composable
fun HudClock(style: TextStyle = Tac.DataSmall) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    Text(SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date(now)), style = style)
}

// ---- controls ---------------------------------------------------------------

@Composable
fun TacButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    accent: Color = Tac.Cyan,
    enabled: Boolean = true,
    primary: Boolean = false,
) {
    val c = if (enabled) accent else Tac.TextFaint
    Box(
        modifier
            .height(40.dp)
            .widthIn(min = 88.dp)
            .clip(RoundedCornerShape(2.dp))
            .background(if (primary && enabled) c.copy(alpha = 0.14f) else Color.Transparent)
            .border(1.dp, c.copy(alpha = if (primary) 0.9f else 0.45f), RoundedCornerShape(2.dp))
            .then(if (primary && enabled) Modifier.cornerBrackets(c, 6.dp, 2.dp) else Modifier)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text.uppercase(), style = Tac.Label.copy(color = c, fontSize = Tac.Label.fontSize * 1.1f))
    }
}

/** Squared toggle in place of a Material switch. */
@Composable
fun TacToggle(checked: Boolean, onChange: (Boolean) -> Unit, enabled: Boolean = true, accent: Color = Tac.Cyan) {
    val c = if (!enabled) Tac.TextFaint else if (checked) accent else Tac.TextFaint
    Row(
        Modifier
            .clip(RoundedCornerShape(2.dp))
            .border(1.dp, c.copy(alpha = 0.6f), RoundedCornerShape(2.dp))
            .clickable(enabled = enabled, interactionSource = remember { MutableInteractionSource() }, indication = null) { onChange(!checked) }
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Box(Modifier.size(width = 18.dp, height = 14.dp).background(if (!checked) Tac.TextFaint.copy(alpha = 0.5f) else Color.Transparent))
        Box(Modifier.size(width = 18.dp, height = 14.dp).background(if (checked) c else Color.Transparent))
    }
}

@Composable
fun ToggleRow(title: String, subtitle: String? = null, checked: Boolean, onChange: (Boolean) -> Unit, enabled: Boolean = true, accent: Color = Tac.Cyan) {
    Row(Modifier.fillMaxWidth().padding(vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title.uppercase(), style = Tac.Data.copy(color = if (enabled) Tac.Text else Tac.TextFaint, letterSpacing = Tac.Label.letterSpacing))
            subtitle?.let { Text(it, style = Tac.DataSmall.copy(color = Tac.TextFaint)) }
        }
        TacToggle(checked, onChange, enabled, accent)
    }
}

@Composable
fun TacSlider(label: String, value: Float, valueText: String, range: ClosedFloatingPointRange<Float>, steps: Int = 0, enabled: Boolean = true, onChange: (Float) -> Unit, onDone: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Row(Modifier.fillMaxWidth()) {
            Text(label.uppercase(), style = Tac.Label, modifier = Modifier.weight(1f))
            Text(valueText, style = Tac.Data.copy(color = if (enabled) Tac.Cyan else Tac.TextFaint))
        }
        Slider(
            value = value,
            onValueChange = onChange,
            onValueChangeFinished = onDone,
            valueRange = range,
            steps = steps,
            enabled = enabled,
            colors = SliderDefaults.colors(
                thumbColor = Tac.Cyan,
                activeTrackColor = Tac.Cyan.copy(alpha = 0.8f),
                inactiveTrackColor = Tac.Hairline,
                activeTickColor = Color.Transparent,
                inactiveTickColor = Color.Transparent,
                disabledThumbColor = Tac.TextFaint,
                disabledActiveTrackColor = Tac.TextFaint,
            ),
            modifier = Modifier.height(30.dp),
        )
    }
}

@Composable
fun TacField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    password: Boolean = false,
    keyboard: KeyboardType = KeyboardType.Text,
    enabled: Boolean = true,
) {
    Column(modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(label.uppercase(), style = Tac.Label)
        Spacer(Modifier.height(5.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(2.dp))
                .background(Tac.Void.copy(alpha = 0.6f))
                .border(1.dp, Tac.Hairline, RoundedCornerShape(2.dp))
                .padding(horizontal = 11.dp, vertical = 11.dp),
        ) {
            if (value.isEmpty()) Text(placeholder, style = Tac.Data.copy(color = Tac.TextFaint))
            BasicTextField(
                value = value,
                onValueChange = onChange,
                enabled = enabled,
                singleLine = true,
                textStyle = Tac.Data,
                cursorBrush = SolidColor(Tac.Cyan),
                visualTransformation = if (password) PasswordVisualTransformation('•') else VisualTransformation.None,
                keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else keyboard, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** Segmented selector (e.g. transport: AUTO / TCP / UDP). */
@Composable
fun Segmented(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    Row(Modifier.border(1.dp, Tac.Hairline, RoundedCornerShape(2.dp))) {
        options.forEach { (value, label) ->
            val on = value == selected
            Box(
                Modifier
                    .background(if (on) Tac.Cyan.copy(alpha = 0.14f) else Color.Transparent)
                    .clickable { onSelect(value) }
                    .padding(horizontal = 14.dp, vertical = 8.dp),
            ) { Text(label, style = Tac.Label.copy(color = if (on) Tac.Cyan else Tac.TextDim)) }
        }
    }
}

// ---- chrome -----------------------------------------------------------------

@Composable
fun TopBar(
    title: String,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Column(Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Tac.Void, Tac.Void.copy(alpha = 0.85f)))).statusBarsPadding()) {
        Row(Modifier.fillMaxWidth().height(54.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) {
                Box(Modifier.size(36.dp).clip(RoundedCornerShape(2.dp)).clickable(onClick = onBack), contentAlignment = Alignment.Center) {
                    Text("‹", style = Tac.Headline.copy(color = Tac.Cyan))
                }
                Spacer(Modifier.width(6.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(title.uppercase(), style = Tac.Title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                subtitle?.let { Text(it, style = Tac.DataSmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp), content = actions)
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Brush.horizontalGradient(listOf(Tac.Cyan.copy(alpha = 0.5f), Tac.Hairline, Color.Transparent))))
    }
}

@Composable
fun IconTextButton(text: String, color: Color = Tac.Cyan, badge: Int = 0, onClick: () -> Unit) {
    Box {
        Box(
            Modifier.clip(RoundedCornerShape(2.dp)).border(1.dp, color.copy(alpha = 0.4f), RoundedCornerShape(2.dp)).clickable(onClick = onClick).padding(horizontal = 9.dp, vertical = 6.dp),
        ) { Text(text, style = Tac.Label.copy(color = color)) }
        if (badge > 0) {
            Box(
                Modifier.align(Alignment.TopEnd).offset(x = 8.dp, y = (-8).dp).clip(RoundedCornerShape(2.dp)).background(Tac.Amber).padding(horizontal = 4.dp, vertical = 1.dp),
            ) { Text(if (badge > 99) "99+" else "$badge", style = Tac.DataSmall.copy(color = Tac.Void, fontSize = Tac.DataSmall.fontSize * 0.9f)) }
        }
    }
}


@Composable
fun EmptyState(title: String, detail: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Column(modifier.fillMaxWidth().padding(vertical = 36.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(56.dp).cornerBrackets(Tac.TextFaint, 12.dp, 1.5.dp), contentAlignment = Alignment.Center) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(Tac.TextFaint))
        }
        Spacer(Modifier.height(14.dp))
        Text(title.uppercase(), style = Tac.Title.copy(color = Tac.TextDim))
        Spacer(Modifier.height(6.dp))
        Text(detail, style = Tac.Body.copy(color = Tac.TextFaint))
        action?.let { Spacer(Modifier.height(16.dp)); it() }
    }
}

@Composable
fun BoxScope.ScanlineOverlay() {
    Box(Modifier.matchParentSize().drawBehind {
        var y = 0f
        while (y < size.height) { drawLine(Color(0x0AFFFFFF), Offset(0f, y), Offset(size.width, y), 1f); y += 3f }
    })
}

@Composable
fun FullScreen(content: @Composable BoxScope.() -> Unit) = Box(Modifier.fillMaxSize().tacticalBackground(), content = content)
