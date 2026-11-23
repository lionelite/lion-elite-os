"""Lion Elite bot community: Python worker bots that stand ready for tasks.

A task goes in (a skill name plus a JSON payload, or free text), the router
picks the bot that owns that skill, and the result is written to a durable
SQLite task board. Nothing here sends e-mail, SMS, DMs or social posts, spends
money, or flips a send switch: those are refused by `guardrails.py` before a
task is ever stored.
"""

__version__ = "0.1.0"
