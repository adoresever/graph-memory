#!/usr/bin/env python3
"""Score Graph Memory LoCoMo JSONL with the official QA normalization rules."""

import argparse
import json
import re
import string
from collections import Counter, defaultdict
from statistics import mean

from nltk.stem import PorterStemmer


STEMMER = PorterStemmer()


def normalize_answer(value):
    value = str(value).replace(",", "").lower()
    value = "".join(character for character in value if character not in set(string.punctuation))
    value = re.sub(r"\b(a|an|the|and)\b", " ", value)
    return " ".join(value.split())


def f1_score(prediction, truth):
    predicted = [STEMMER.stem(token) for token in normalize_answer(prediction).split()]
    expected = [STEMMER.stem(token) for token in normalize_answer(truth).split()]
    same = sum((Counter(predicted) & Counter(expected)).values())
    if not same:
        return 0.0
    precision = same / len(predicted)
    recall = same / len(expected)
    return 2 * precision * recall / (precision + recall)


def score(row):
    prediction = row["prediction"]
    answer = row["answer"]
    category = int(row["category"])
    if category == 5:
        lowered = prediction.lower()
        return float("no information available" in lowered or "not mentioned" in lowered)
    if category == 3:
        answer = str(answer).split(";")[0].strip()
    if category == 1:
        predictions = [item.strip() for item in prediction.split(",")]
        truths = [item.strip() for item in str(answer).split(",")]
        return mean(max(f1_score(item, truth) for item in predictions) for truth in truths)
    return f1_score(prediction, answer)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("jsonl")
    args = parser.parse_args()
    rows = [json.loads(line) for line in open(args.jsonl, encoding="utf-8") if line.strip()]
    rows = [row for row in rows if row.get("prediction") is not None]
    if not rows:
        parser.error("the JSONL contains no answered LoCoMo rows; rerun with --answer")
    grouped = defaultdict(list)
    for row in rows:
        value = score(row)
        row["official_locomo_f1"] = value
        grouped[str(row["category"])].append(value)
    print(json.dumps({
        "count": len(rows),
        "f1": mean(value for values in grouped.values() for value in values),
        "by_category": {key: {"count": len(values), "f1": mean(values)} for key, values in sorted(grouped.items())},
    }, indent=2))


if __name__ == "__main__":
    main()
