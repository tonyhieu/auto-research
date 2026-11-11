# Auto-Research System

I'm trying to build a system that does research on a specific academic topic (such as for my generative model paper) and tries to find some sort of edge/new insight that was not previously discovered. This repo is going to be a harness / system that spins up and coordinates agents to do this research automatically while I'm asleep/inactive to maximize my subscription.

I want the following features:
- Entrypoint: kickoff a command in the form `command_name -t "Topic" -n 2`, where `-t` denotes the topic and `-n` denotes the number of subscription windows to run the research (e.g. 2 five-hour windows for an Anthropic subscription)
  - The agents should use at least 85% of the allotted subscription usage per window
- At the end of research sessions, agents provide a summary of what was discovered and what to look at next
- Per-topic memory and research: Ability to research multiple topics at once, e.g. generative models and distributed systems
  - Ideally, this memory would not interfere with my current memory system that I use for `pi`. We can re-use the same system for this repository too
- Agent coordination: One or more orchestrator agents that fan-out subagents to look into different areas
  - Note that the orchestrator should be reset every so often (as opposed to `/compact`ed) to avoid token waste / long context windows; orchestrator memory should be specially dealt with
  - Subagents collaborate via some on-disk record
- Verification of some sort: Agents should be able to build/verify ideas quickly and easily to prevent hallucinations, though I'm not sure how to build a general verification suite (e.g. math topics vs. CS topics have different methods of verification)
