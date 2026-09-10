#!/usr/bin/env -S nu --stdin

let pending_read_file_base_name = "pending-read.json"
let user_modification_file_base_name = "user-modification.json"
let feedback_file_base_name = "feedback.md"
let diff_file_base_name_stem = "previous"
let plugin_temp_dir_base_name = "teleprompt-commentary"
let run_command_tool_name = "run_command"
let manage_task_tool_name = "manage_task"
let write_to_file_tool_name = "write_to_file"
let replace_file_content_tool_name = "replace_file_content"
let multi_replace_file_content_tool_name = "multi_replace_file_content"
let view_file_tool_name = "view_file"

def normalize [text: string] {
    $text | str trim --right
}

def apply-chunk [lines: list<string>, chunk: record] {
    if $chunk.TargetContent == $chunk.ReplacementContent {
        return $lines
    }
    let start = $chunk.StartLine
    let end = $chunk.EndLine
    if ($start | describe) != "int" or ($end | describe) != "int" {
        error make
    }
    let before = ($lines | take ($start - 1))
    let target_block = (
        $lines
        | skip ($start - 1)
        | take ($end - $start + 1)
        | each { |line| $line + "\n" }
        | str join ""
    )
    let after = ($lines | skip $end)
    let replace_all = ($chunk.AllowMultiple? | default false)
    let new_block = if $replace_all {
        $target_block
        | str replace --all $chunk.TargetContent $chunk.ReplacementContent
    } else {
        $target_block
        | str replace $chunk.TargetContent $chunk.ReplacementContent
    }
    let trimmed_block = if ($new_block | str ends-with "\n") {
        $new_block | str replace --regex "\n$" ""
    } else {
        $new_block
    }
    let new_lines = if ($trimmed_block | is-empty) {
        []
    } else {
        $trimmed_block | split row "\n"
    }
    (
        $before
        | append $new_lines
        | append $after
    )
}

def allow [] {
    print ({ decision: "allow" } | to json)
}

def deny [reason: string] {
    print ({ decision: "deny", reason: $reason } | to json)
}

def ask [] {
    print ({ decision: "ask" } | to json)
}

def force-ask [] {
    print ({ decision: "force_ask" } | to json)
}

def get-session-dir [conversation_id: string] {
    [$nu.temp-dir $plugin_temp_dir_base_name $conversation_id] | path join
}

def execute-pre-tool-use [] {
    let payload = $in | from json
    let tool_name = $payload.toolCall.name
    let args = $payload.toolCall.args?
    let conversation_id = $payload.conversationId
    let session_dir = (get-session-dir $conversation_id)
    let pending_read_file_path = ($session_dir | path join $pending_read_file_base_name)
    if ($pending_read_file_path | path exists) {
        let pending = (open $pending_read_file_path)
        if $tool_name == $view_file_tool_name {
            let current_target = ($args.AbsolutePath? | path expand)
            if $current_target == ($pending.path | path expand) {
                rm -f $pending_read_file_path
                allow

                return
            }
        }
        deny $"Follow the rules of commentary! Read the modified file at ($pending.path) before running `($tool_name)`."

        return
    }
    # Only write tools (as of the time of writing this) have the `TargetFile` arg
    let target_file_path = $args.TargetFile?
    if ($target_file_path | is-empty) {
        if $tool_name == $run_command_tool_name or $tool_name == $manage_task_tool_name {
            force-ask
        } else {
            ask
        }

        return
    }
    let target_file_path = ($target_file_path | path expand)
    let extension = ($target_file_path | path parse | get extension)
    let diff_file_path = ($session_dir | path join (if ($extension | is-empty) { $diff_file_base_name_stem } else { $"($diff_file_base_name_stem).($extension)" }))
    let user_modification_file_path = ($session_dir | path join $user_modification_file_base_name)
    let feedback_file_path = ($session_dir | path join $feedback_file_base_name)
    mkdir $session_dir
    rm -f $user_modification_file_path
    rm -f $feedback_file_path
    let is_new_file = not ($target_file_path | path exists)
    let orig_text = if $is_new_file { "" } else { open --raw $target_file_path }
    let orig_lines = $orig_text | split row "\n"
    let new_text = if $tool_name == $write_to_file_tool_name {
        $args.CodeContent
    } else if $tool_name == $replace_file_content_tool_name or $tool_name == $multi_replace_file_content_tool_name {
        let chunks = if $tool_name == $replace_file_content_tool_name {
            [$args]
        } else {
            $args.ReplacementChunks
        }
        (
            $chunks
            | sort-by -r StartLine
            | reduce -f $orig_lines {|chunk, acc|
                apply-chunk $acc $chunk
            }
            | str join "\n"
        )
    } else {
        ask
        return
    }
    mkdir ($target_file_path | path dirname)
    $orig_text | save -f $diff_file_path
    $new_text | save -f $target_file_path
    if $is_new_file {
        # ^zeditor --wait --add $target_file_path
        ^code --wait --add --reuse-window $target_file_path
    } else {
        # ^zeditor --wait --add --diff $diff_file_path $target_file_path
        ^code --wait --add --reuse-window --diff $diff_file_path $target_file_path
    }
    let content_after_review = open --raw $target_file_path
    let user_modified = (normalize $new_text) != (normalize $content_after_review)
    if $is_new_file {
        rm -f $target_file_path
    } else {
        $orig_text | save -f $target_file_path
    }
    let feedback = if $user_modified {
        { filePath: $target_file_path, replaceContent: $content_after_review }
        | to json
        | save -f $user_modification_file_path
        ""
    } else {
        "" | save -f $feedback_file_path
        # ^zeditor --wait --add $feedback_file_path
        ^code --wait --add --reuse-window $feedback_file_path
        open --raw $feedback_file_path | str trim
    }
    rm -f $feedback_file_path
    rm -f $diff_file_path
    if ($feedback | is-not-empty) {
        deny $"The user discarded your edits completely. User says: ($feedback)"
    } else {
        allow
    }
}

def execute-post-tool-use [] {
    let payload = $in | from json
    let tool_name = $payload.toolCall?.name?
    if ($tool_name | is-not-empty) {
        if $tool_name == $write_to_file_tool_name or $tool_name == $replace_file_content_tool_name or $tool_name == $multi_replace_file_content_tool_name {
            let conversation_id = $payload.conversationId
            let session_dir = (get-session-dir $conversation_id)
            let user_modification_file_path = ($session_dir | path join $user_modification_file_base_name)
            if ($user_modification_file_path | path exists) {
                let mod = (open $user_modification_file_path)
                $mod.replaceContent | save -f $mod.filePath
                rm -f $user_modification_file_path
            }
            let target_file_path = ($payload.toolCall?.args?.TargetFile? | path expand)
            { path: $target_file_path } | to json | save -f ($session_dir | path join $pending_read_file_base_name)
        }
    }
    print "{}"
}

def execute-post-invocation [] {
    let payload = $in | from json
    let conversation_id = $payload.conversationId
    let session_dir = (get-session-dir $conversation_id)
    let pending_file_path = ($session_dir | path join $pending_read_file_base_name)
    if ($pending_file_path | path exists) {
        let pending = (open $pending_file_path)
        let response = {
            injectSteps: [
                {
                    ephemeralMessage: $"You're not following the rules of commentary! Please read the file ($pending.path) before you proceed."
                }
            ],
            terminationBehavior: "force_continue"
        }
        print ($response | to json)
    } else {
        let response = {
            injectSteps: [
                {
                    ephemeralMessage: $"I hope you've responded to all pending `agent:` comments in the files you edited. If so, I hope you've deleted all the `agent:` and `user:` comments."
                }
            ],
            terminationBehavior: ""
        }
        print ($response | to json)
    }
}

def execute-stop [] {
    let payload = $in | from json
    let conversation_id = $payload.conversationId
    let session_dir = (get-session-dir $conversation_id)
    let pending_file_path = ($session_dir | path join $pending_read_file_base_name)
    if ($pending_file_path | path exists) {
        rm -f $pending_file_path
    }
    print "{}"
}

def main [event: string] {
    let raw_payload = $in
    try {
        if $event == "pre-invocation" {
            $raw_payload | execute-pre-invocation
        } else if $event == "post-invocation" {
            $raw_payload | execute-post-invocation
        } else if $event == "stop" {
            $raw_payload | execute-stop
        }
    } catch { |err|
        print "{}"
        ^notify-send -i antigravity "Error occurred" $"Teleprompt hook crashed with error ($err | debug)"
    }
    try {
        if $event == "pre-tool-use" {
            $raw_payload | execute-pre-tool-use
        } else if $event == "post-tool-use" {
            $raw_payload | execute-post-tool-use
        }
    } catch { |err|
        force-ask
        ^notify-send -i antigravity "Error occured" $"Teleprompt hook crashed with error ($err | debug)"
    }
}
